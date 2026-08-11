import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import type { IProvider, IProviderModels } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
  ProviderModelsResult,
  ProviderSessionModel,
} from '@/shared/types.js';

export const PROVIDER_MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** Short-lived in-memory TTL for `cacheable=false` fallback results. */
export const PROVIDER_MODELS_FALLBACK_TTL_MS = 5 * 60 * 1000;
const PROVIDER_MODELS_CACHE_VERSION = 2;
const UNCACHED_PROVIDERS = new Set<LLMProvider>(['claude']);

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionStore = {
  getSessionById(sessionId: string): { model: string | null } | null;
  setSessionModel(sessionId: string, model: string): void;
};

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  assertProviderAuthenticated?: (provider: LLMProvider) => Promise<void> | void;
  cachePath?: string;
  sessions?: ProviderModelsSessionStore;
  now?: () => number;
};

type ProviderModelsOptions = {
  bypassCache?: boolean;
};

type ProviderModelsCacheEntry = {
  updatedAt: number;
  expiresAt: number;
  models: ProviderModelsDefinition;
  /** false = fallback from a failed configured API fetch: memory-only, never persisted. */
  cacheable: boolean;
};

type ProviderModelsCacheFile = {
  version: number;
  entries: Record<string, ProviderModelsCacheEntry>;
};

const getProviderModelsCachePath = (): string => path.join(
  os.homedir(),
  '.cloudcli',
  'provider-models-cache.json',
);

const buildCacheKey = (provider: LLMProvider, fingerprint: string): string => `${provider}:${fingerprint}`;

const toProviderModelsCacheInfo = (
  entry: ProviderModelsCacheEntry,
  source: ProviderModelsCacheInfo['source'],
): ProviderModelsCacheInfo => ({
  updatedAt: new Date(entry.updatedAt).toISOString(),
  expiresAt: new Date(entry.expiresAt).toISOString(),
  source,
});

const isProviderModelOption = (
  value: unknown,
): value is ProviderModelsDefinition['OPTIONS'][number] => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).value === 'string'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).label === 'string'
  && (
    typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'undefined'
    || typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'string'
  )
);

const isProviderModelsDefinition = (value: unknown): value is ProviderModelsDefinition => (
  Boolean(value)
  && typeof value === 'object'
  && Array.isArray((value as ProviderModelsDefinition).OPTIONS)
  && (value as ProviderModelsDefinition).OPTIONS.every(isProviderModelOption)
  && typeof (value as ProviderModelsDefinition).DEFAULT === 'string'
);

const isProviderModelsCacheEntry = (value: unknown): value is ProviderModelsCacheEntry => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsCacheEntry).updatedAt === 'number'
  && typeof (value as ProviderModelsCacheEntry).expiresAt === 'number'
  && isProviderModelsDefinition((value as ProviderModelsCacheEntry).models)
);

const readProviderModelsCacheFile = async (
  cachePath: string,
): Promise<ProviderModelsCacheFile | null> => {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderModelsCacheFile>;
    if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return null;
    }

    const entries = Object.fromEntries(
      Object.entries(parsed.entries).filter((entry): entry is [string, ProviderModelsCacheEntry] =>
        isProviderModelsCacheEntry(entry[1]),
      ),
    );

    return {
      version: PROVIDER_MODELS_CACHE_VERSION,
      entries,
    };
  } catch {
    return null;
  }
};

const writeProviderModelsCacheFile = async (
  cachePath: string,
  entries: Map<string, ProviderModelsCacheEntry>,
  now: number,
): Promise<void> => {
  const serializableEntries = Object.fromEntries(
    [...entries.entries()].filter(
      ([, entry]) => entry.cacheable !== false && entry.expiresAt > now,
    ),
  );
  const payload: ProviderModelsCacheFile = {
    version: PROVIDER_MODELS_CACHE_VERSION,
    entries: serializableEntries,
  };

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

/**
 * Provider model lookup service.
 *
 * Routes and other service callers use this layer instead of resolving provider
 * classes directly so the provider-registry dependency stays centralized in one
 * place.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider
    ?? ((provider: LLMProvider) => providerRegistry.resolveProvider(provider));
  const assertProviderAuthenticated = dependencies.assertProviderAuthenticated
    ?? ((provider: LLMProvider) => providerAuthService.assertProviderAuthenticated(provider));
  const cachePath = dependencies.cachePath ?? getProviderModelsCachePath();
  const sessions = dependencies.sessions ?? sessionsDb;
  const now = dependencies.now ?? (() => Date.now());
  const memoryCache = new Map<string, ProviderModelsCacheEntry>();
  const pendingRequests = new Map<string, Promise<ProviderModelsResult>>();
  let persistedCacheLoaded = false;
  let persistedCacheLoadPromise: Promise<void> | null = null;

  const pruneExpiredMemoryEntry = (
    cacheKey: string,
    currentTime: number,
    source: ProviderModelsCacheInfo['source'],
  ): ProviderModelsResult | null => {
    const cachedEntry = memoryCache.get(cacheKey);
    if (!cachedEntry) {
      return null;
    }

    if (cachedEntry.expiresAt > currentTime) {
      return {
        models: cachedEntry.models,
        cache: toProviderModelsCacheInfo(cachedEntry, source),
      };
    }

    memoryCache.delete(cacheKey);
    return null;
  };

  const loadPersistedCache = async (): Promise<void> => {
    if (persistedCacheLoaded) {
      return;
    }

    if (!persistedCacheLoadPromise) {
      persistedCacheLoadPromise = (async () => {
        const cacheFile = await readProviderModelsCacheFile(cachePath);
        const currentTime = now();

        for (const [cacheKey, entry] of Object.entries(cacheFile?.entries ?? {})) {
          if (entry.expiresAt > currentTime) {
            memoryCache.set(cacheKey, { ...entry, cacheable: entry.cacheable !== false });
          }
        }

        persistedCacheLoaded = true;
      })().finally(() => {
        persistedCacheLoadPromise = null;
      });
    }

    await persistedCacheLoadPromise;
  };

  const persistCache = async (): Promise<void> => {
    try {
      await writeProviderModelsCacheFile(cachePath, memoryCache, now());
    } catch (error) {
      console.warn('Unable to persist provider models cache:', error);
    }
  };

  const setCacheEntry = async (
    provider: LLMProvider,
    fingerprint: string,
    models: ProviderModelsDefinition,
    cacheable: boolean,
  ): Promise<ProviderModelsCacheEntry> => {
    const currentTime = now();
    const ttl = cacheable ? PROVIDER_MODELS_CACHE_TTL_MS : PROVIDER_MODELS_FALLBACK_TTL_MS;
    const entry: ProviderModelsCacheEntry = {
      updatedAt: currentTime,
      expiresAt: currentTime + ttl,
      models,
      cacheable,
    };

    memoryCache.set(buildCacheKey(provider, fingerprint), entry);
    if (cacheable) {
      await persistCache();
    }
    return entry;
  };

  const loadAndCacheModels = (
    models: IProviderModels,
    provider: LLMProvider,
    fingerprint: string,
  ): Promise<ProviderModelsResult> => {
    const cacheKey = buildCacheKey(provider, fingerprint);
    const request = models.getSupportedModels()
      .then(async (catalog) => {
        const entry = await setCacheEntry(provider, catalog.fingerprint, catalog.models, catalog.cacheable);
        return {
          models: catalog.models,
          cache: toProviderModelsCacheInfo(entry, 'fresh'),
        };
      })
      .finally(() => {
        pendingRequests.delete(cacheKey);
      });

    pendingRequests.set(cacheKey, request);
    return request;
  };

  const loadDirectModels = (
    models: IProviderModels,
    provider: LLMProvider,
  ): Promise<ProviderModelsResult> => {
    const cacheKey = buildCacheKey(provider, '');
    const request = models.getSupportedModels()
      .then((catalog) => {
        const currentTime = now();
        return {
          models: catalog.models,
          cache: {
            updatedAt: new Date(currentTime).toISOString(),
            expiresAt: new Date(currentTime).toISOString(),
            source: 'fresh' as const,
          },
        };
      })
      .finally(() => {
        pendingRequests.delete(cacheKey);
      });

    pendingRequests.set(cacheKey, request);
    return request;
  };

  const getProviderModels = async (
    provider: LLMProvider,
    options: ProviderModelsOptions = {},
  ): Promise<ProviderModelsResult> => {
    await assertProviderAuthenticated(provider);
    const models = resolveProvider(provider).models;
    if (UNCACHED_PROVIDERS.has(provider)) {
      const pendingRequest = pendingRequests.get(buildCacheKey(provider, ''));
      if (pendingRequest) {
        return pendingRequest;
      }

      return loadDirectModels(models, provider);
    }

    // Precompute the configuration-driven fingerprint so the cache lookup uses
    // the same key catalog writes do. Unconfigured providers (or facets without
    // the method) return an empty fingerprint, which keeps the key equivalent
    // to the previous provider-only key.
    const fingerprint = models.getCachedCatalogFingerprint?.() ?? '';
    const cacheKey = buildCacheKey(provider, fingerprint);

    if (options.bypassCache) {
      const pendingRequest = pendingRequests.get(cacheKey);
      if (pendingRequest) {
        return pendingRequest;
      }

      return loadAndCacheModels(models, provider, fingerprint);
    }

    const pendingRequest = pendingRequests.get(cacheKey);
    if (pendingRequest) {
      return pendingRequest;
    }

    const cachedModels = pruneExpiredMemoryEntry(cacheKey, now(), 'memory');
    if (cachedModels) {
      return cachedModels;
    }

    await loadPersistedCache();

    const persistedModels = pruneExpiredMemoryEntry(cacheKey, now(), 'disk');
    if (persistedModels) {
      return persistedModels;
    }

    const postLoadPendingRequest = pendingRequests.get(cacheKey);
    if (postLoadPendingRequest) {
      return postLoadPendingRequest;
    }

    return loadAndCacheModels(models, provider, fingerprint);
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const readRecordedSessionModel = (sessionId: string): string | null => {
    const session = sessions.getSessionById(sessionId);
    return session?.model?.trim() || null;
  };

  /**
   * Records the model one session runs with.
   *
   * Called from the active-model route when the user picks a model and from
   * `chat.send` on every turn, so the row always matches what the session last
   * ran with. Sessions the app has not created yet (no row) are ignored rather
   * than treated as an error: the client keeps its own pending selection and
   * the value lands on the row with the first send.
   */
  const setSessionModel = async (
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): Promise<ProviderSessionModel | null> => {
    await assertProviderAuthenticated(provider);
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return null;
    }

    if (!sessions.getSessionById(normalizedSessionId)) {
      return null;
    }

    sessions.setSessionModel(normalizedSessionId, normalizedModel);
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      source: 'session',
    };
  };

  /**
   * Answers "which model is this session using?" for every display surface.
   *
   * Precedence, highest first:
   *   1. the model recorded on the session row — the user's pick, or whatever
   *      the last send used;
   *   2. the provider's own session state, for sessions started outside the app
   *      that we have never recorded a model for;
   *   3. `requestedModel`, the client's current default, for a chat that has no
   *      session yet;
   *   4. the provider catalog default.
   */
  const resolveSessionModel = async (
    provider: LLMProvider,
    options: { sessionId?: string | null; requestedModel?: string | null } = {},
  ): Promise<ProviderSessionModel> => {
    const normalizedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const normalizedRequestedModel = typeof options.requestedModel === 'string'
      ? options.requestedModel.trim()
      : '';

    if (normalizedSessionId) {
      const recordedModel = readRecordedSessionModel(normalizedSessionId);
      if (recordedModel) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: recordedModel,
          source: 'session',
        };
      }

      // Never sent on through the app. Ask the provider what its own session
      // state says before falling back to anything client-supplied.
      const catalog = (await getProviderModels(provider)).models;
      const providerModel = await getCurrentActiveModel(provider, normalizedSessionId);
      const resolvedProviderModel = providerModel.model?.trim();
      if (resolvedProviderModel && resolvedProviderModel !== catalog.DEFAULT) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: resolvedProviderModel,
          source: 'provider',
        };
      }

      return {
        provider,
        sessionId: normalizedSessionId,
        model: normalizedRequestedModel || catalog.DEFAULT,
        source: normalizedRequestedModel ? 'session' : 'default',
      };
    }

    if (normalizedRequestedModel) {
      return {
        provider,
        sessionId: null,
        model: normalizedRequestedModel,
        source: 'session',
      };
    }

    const catalog = (await getProviderModels(provider)).models;
    return {
      provider,
      sessionId: null,
      model: catalog.DEFAULT,
      source: 'default',
    };
  };

  /**
   * Picks the model one run should use, for provider runtime adapters.
   *
   * Deliberately narrower than `resolveSessionModel`: the provider's own
   * session state is not consulted here. Codex reports a global config value
   * from `getCurrentActiveModel`, which would silently override the model the
   * user picked in the composer on every single run.
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    void provider;
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      return normalizedRequestedModel || undefined;
    }

    const recordedModel = readRecordedSessionModel(normalizedSessionId);
    return recordedModel || normalizedRequestedModel || undefined;
  };

  /**
   * Resolves the model input for one provider run without provider-id policy.
   *
   * Explicit caller choices always win. An omitted choice loads the selected
   * provider's catalog only when its model facet requests catalog-default
   * injection; otherwise the runtime/CLI receives `undefined` and owns its
   * native default selection.
   */
  const resolveRunModel = async (
    provider: LLMProvider,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    const normalizedRequestedModel = typeof requestedModel === 'string'
      ? requestedModel.trim()
      : '';
    if (normalizedRequestedModel) {
      return normalizedRequestedModel;
    }

    const models = resolveProvider(provider).models;
    if (models.usesCatalogDefaultWhenModelOmitted !== true) {
      return undefined;
    }

    return (await getProviderModels(provider)).models.DEFAULT;
  };

  const clearCache = (): void => {
    memoryCache.clear();
    pendingRequests.clear();
    persistedCacheLoaded = false;
    persistedCacheLoadPromise = null;
  };

  return {
    getProviderModels,
    setSessionModel,
    resolveSessionModel,
    resolveResumeModel,
    resolveRunModel,
    clearCache,
  };
};

export const providerModelsService = createProviderModelsService();
