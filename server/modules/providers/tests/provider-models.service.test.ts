import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProviderModelsService,
  PROVIDER_MODELS_CACHE_TTL_MS,
  PROVIDER_MODELS_FALLBACK_TTL_MS,
} from '@/modules/providers/services/provider-models.service.js';
import { providerRegistry } from '@/modules/providers/index.js';
import type {
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError, computeModelsFingerprint } from '@/shared/utils.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({
  model,
});

/** In-memory stand-in for the `sessions` table rows the service reads and writes. */
const createSessionStore = (rows: Record<string, string | null> = {}) => {
  const sessions = new Map(Object.entries(rows));
  return {
    sessions,
    getSessionById: (sessionId: string) =>
      (sessions.has(sessionId) ? { model: sessions.get(sessionId) ?? null } : null),
    setSessionModel: (sessionId: string, model: string) => {
      sessions.set(sessionId, model);
    },
  };
};

const createEphemeralCachePath = (): string => path.join(
  os.tmpdir(),
  `provider-model-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

test('provider models service delegates to the resolved provider model adapter', async () => {
  const calls: LLMProvider[] = [];
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => {
      calls.push(provider);
      return {
        models: {
          getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      };
    },
  });

  const models = await service.getProviderModels('codex', { bypassCache: true });

  assert.deepEqual(calls, ['codex']);
  assert.equal(models.models.DEFAULT, 'codex-models');
  assert.equal(models.cache.source, 'fresh');
});

test('provider models service returns each provider adapter result without rewriting it', async () => {
  const expectedModels: ProviderModelsDefinition = {
    OPTIONS: [
      { value: 'cursor-a', label: 'Cursor A' },
      { value: 'cursor-b', label: 'Cursor B' },
    ],
    DEFAULT: 'cursor-b',
  };

  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => ({ models: expectedModels, fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
      },
    }),
  });

  const models = await service.getProviderModels('cursor', { bypassCache: true });

  assert.deepEqual(models.models, expectedModels);
});

test('provider models are cached for the three-day ttl', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-ttl-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return { models: createModels(`${provider}-${loadCount}`), fingerprint: '', cacheable: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const first = await service.getProviderModels('codex');
    const cached = await service.getProviderModels('codex');
    assert.equal(loadCount, 1);
    assert.equal(cached.models.DEFAULT, first.models.DEFAULT);
    assert.equal(cached.cache.source, 'memory');

    currentTime += PROVIDER_MODELS_CACHE_TTL_MS - 1;
    await service.getProviderModels('codex');
    assert.equal(loadCount, 1);

    currentTime += 2;
    const refreshed = await service.getProviderModels('codex');
    assert.equal(loadCount, 2);
    assert.equal(refreshed.models.DEFAULT, 'codex-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('claude provider models are always loaded directly from the provider', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-claude-direct-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return { models: createModels(`${provider}-${loadCount}`), fingerprint: '', cacheable: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    const second = await service.getProviderModels('claude');

    assert.equal(loadCount, 2);
    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(second.models.DEFAULT, 'claude-2');
    assert.equal(second.cache.source, 'fresh');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('provider model cache is persisted across service instances', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-file-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');

  try {
    const writer = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => ({ models: createModels('cursor-cached'), fingerprint: '', cacheable: true }),
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });
    await writer.getProviderModels('cursor');

    const reader = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw new Error('loader should not be called for persisted cache hits');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });
    const models = await reader.getProviderModels('cursor');
    assert.equal(models.models.DEFAULT, 'cursor-cached');
    assert.equal(models.cache.source, 'disk');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent provider model requests share one load operation', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-pending-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { models: createModels('claude-cached'), fingerprint: '', cacheable: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('claude-active'),
        },
      }),
    });

    const [first, second] = await Promise.all([
      service.getProviderModels('claude'),
      service.getProviderModels('claude'),
    ]);

    assert.equal(loadCount, 1);
    assert.equal(first.models.DEFAULT, 'claude-cached');
    assert.equal(second.models.DEFAULT, 'claude-cached');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('bypassCache forces a fresh provider fetch and updates cache metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-refresh-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return { models: createModels(`${provider}-${loadCount}`), fingerprint: '', cacheable: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active-${loadCount}`),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    currentTime += 50;
    const refreshed = await service.getProviderModels('claude', { bypassCache: true });

    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(refreshed.models.DEFAULT, 'claude-2');
    assert.equal(refreshed.cache.source, 'fresh');
    assert.notEqual(refreshed.cache.updatedAt, first.cache.updatedAt);
    assert.equal(loadCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveSessionModel asks the provider adapter for the session it was given', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions: createSessionStore({ 'session-123': null }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async (sessionId) => {
          calls.push({ provider, sessionId });
          return createCurrentActiveModel(`${provider}-${sessionId}`);
        },
      },
    }),
  });

  const resolved = await service.resolveSessionModel('opencode', { sessionId: 'session-123' });

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(resolved.model, 'opencode-session-123');
});
test('setSessionModel records the model on the session row', async () => {
  const sessions = createSessionStore({ 'session-1': null });
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  const stored = await service.setSessionModel('claude', 'session-1', 'opus');

  assert.deepEqual(stored, {
    provider: 'claude',
    sessionId: 'session-1',
    model: 'opus',
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1'), 'opus');
});

test('setSessionModel ignores sessions that have no row yet', async () => {
  const sessions = createSessionStore();
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  assert.equal(await service.setSessionModel('claude', 'missing-session', 'opus'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('resolveSessionModel prefers the recorded session model over everything else', async () => {
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions: createSessionStore({ 'session-1': 'haiku' }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'sonnet',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to provider session state for sessions the app never recorded', async () => {
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions: createSessionStore({ 'session-1': null }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('opencode', {
    sessionId: 'session-1',
    requestedModel: 'requested',
  });

  assert.equal(resolved.model, 'provider-reported');
  assert.equal(resolved.source, 'provider');
});

test('resolveSessionModel uses the requested model when the provider only reports its catalog default', async () => {
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    sessions: createSessionStore({ 'session-1': null }),
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => ({ models: createModels('default'), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel('default'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'haiku',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel answers with the requested model for a chat that has no session yet', async () => {
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions: createSessionStore(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('codex', { requestedModel: 'gpt-5.5' });

  assert.equal(resolved.model, 'gpt-5.5');
  assert.equal(resolved.sessionId, null);
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to the catalog default with nothing else to go on', async () => {
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    sessions: createSessionStore(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('codex');

  assert.equal(resolved.model, 'codex-models');
  assert.equal(resolved.source, 'default');
});

test('resolveResumeModel prefers the recorded session model over the requested one', async () => {
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions: createSessionStore({ 'session-456': 'composer-2' }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
  assert.equal(model, 'composer-2');
});

test('resolveResumeModel never lets provider session state override the requested model', async () => {
  let providerLookups = 0;
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    sessions: createSessionStore({ 'session-456': null }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => {
          providerLookups += 1;
          return createCurrentActiveModel('global-config-model');
        },
      },
    }),
  });

  const model = await service.resolveResumeModel('codex', 'session-456', 'gpt-5.5');

  assert.equal(model, 'gpt-5.5');
  assert.equal(providerLookups, 0);
});

test('resolveRunModel follows provider-owned omitted-model policy', async () => {
  let catalogLoads = 0;
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        usesCatalogDefaultWhenModelOmitted: provider === 'codex',
        getSupportedModels: async () => {
          catalogLoads += 1;
          return { models: createModels(`${provider}-default`), fingerprint: '', cacheable: true };
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    } as never),
  });

  assert.equal(await service.resolveRunModel('claude'), undefined);
  assert.equal(await service.resolveRunModel('codex'), 'codex-default');
  assert.equal(await service.resolveRunModel('claude', 'requested-model'), 'requested-model');
  assert.equal(catalogLoads, 1);
});

test('resolveRunModel keeps the production registry resolver bound to its owner', async () => {
  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    sessions: createSessionStore(),
  });

  assert.equal(await service.resolveRunModel('claude'), undefined);
});

test('five provider model facets characterize their omitted-model policy', () => {
  const policies = Object.fromEntries(
    providerRegistry.listProviders().map((provider) => [
      provider.id,
      provider.models.usesCatalogDefaultWhenModelOmitted === true ? 'catalog' : 'implicit',
    ]),
  );

  assert.deepEqual(policies, {
    claude: 'implicit',
    codex: 'catalog',
    cursor: 'implicit',
    opencode: 'catalog',
    pi: 'catalog',
  });
});

test('getProviderModels rejects an unauthenticated provider before loading models', async () => {
  let loadCalls = 0;
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    assertProviderAuthenticated: async () => {
      throw new AppError('provider 未安装或未认证', {
        code: 'PROVIDER_NOT_AUTHENTICATED',
        statusCode: 401,
      });
    },
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          loadCalls += 1;
          return { models: createModels(`${provider}-models`), fingerprint: '', cacheable: true };
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  await assert.rejects(
    () => service.getProviderModels('codex'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROVIDER_NOT_AUTHENTICATED');
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
  assert.equal(loadCalls, 0);
});

test('setSessionModel rejects an unauthenticated provider before recording the model', async () => {
  const sessions = createSessionStore({ 'session-1': null });
  const service = createProviderModelsService({
    sessions,
    assertProviderAuthenticated: async () => {
      throw new AppError('provider 未安装或未认证', {
        code: 'PROVIDER_NOT_AUTHENTICATED',
        statusCode: 401,
      });
    },
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => ({ models: createModels(`${provider}-models`), fingerprint: '', cacheable: true }),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  await assert.rejects(
    () => service.setSessionModel('claude', 'session-1', 'opus'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROVIDER_NOT_AUTHENTICATED');
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
  assert.equal(sessions.sessions.get('session-1'), null);
});

test('getProviderModels keeps UNSUPPORTED_PROVIDER for unregistered providers', async () => {
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
  });

  await assert.rejects(
    () => service.getProviderModels('nonexistent' as LLMProvider),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_PROVIDER');
      return true;
    },
  );
});

test('R18: a changed base_url fingerprint never reuses the old cached catalog', async () => {
  let fingerprint = 'fp-base-a';
  let loadCount = 0;

  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          loadCount += 1;
          return { models: createModels(fingerprint), fingerprint, cacheable: true };
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  const first = await service.getProviderModels('codex');
  assert.equal(first.models.DEFAULT, 'fp-base-a');
  assert.equal(first.cache.source, 'fresh');

  // base_url 从 A 改 B：指纹变化，旧缓存（fp-base-a）不命中，以 B 重新拉取。
  fingerprint = 'fp-base-b';
  const second = await service.getProviderModels('codex');

  assert.equal(second.models.DEFAULT, 'fp-base-b');
  assert.equal(second.cache.source, 'fresh');
  assert.equal(loadCount, 2);
});

test('R19: a changed credential, model_provider, or model invalidates the cached catalog', async () => {
  const config = { credential: 'sk-credential-a', modelProvider: 'tc-credit', model: 'gpt-5.6-sol' };
  let loadCount = 0;

  const service = createProviderModelsService({
    assertProviderAuthenticated: async () => undefined,
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          loadCount += 1;
          return {
            models: createModels(computeModelsFingerprint(config)),
            fingerprint: computeModelsFingerprint(config),
            cacheable: true,
          };
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  const initialFingerprint = computeModelsFingerprint(config);
  const first = await service.getProviderModels('codex');
  assert.equal(first.models.DEFAULT, initialFingerprint);

  config.credential = 'sk-credential-b';
  const afterCredentialChange = await service.getProviderModels('codex');
  assert.equal(afterCredentialChange.models.DEFAULT, computeModelsFingerprint(config));

  config.modelProvider = 'another-provider';
  const afterProviderChange = await service.getProviderModels('codex');
  assert.equal(afterProviderChange.models.DEFAULT, computeModelsFingerprint(config));

  config.model = 'gpt-5.4';
  const afterModelChange = await service.getProviderModels('codex');
  assert.equal(afterModelChange.models.DEFAULT, computeModelsFingerprint(config));

  assert.equal(loadCount, 4);
});

test('R20: a failed configured fetch fallback stays out of the disk cache and retries after recovery', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-fallback-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  let apiAvailable = false;
  let loadCount = 0;
  let currentTime = 1_000;

  try {
    const service = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath,
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            if (!apiAvailable) {
              return { models: createModels('fallback-catalog'), fingerprint: 'fp-config', cacheable: false };
            }
            return { models: createModels('recovered-catalog'), fingerprint: 'fp-config', cacheable: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const fallback = await service.getProviderModels('codex');
    assert.equal(fallback.models.DEFAULT, 'fallback-catalog');
    assert.equal(fallback.cache.source, 'fresh');

    // cacheable=false → 不写磁盘缓存。
    await assert.rejects(() => readFile(cachePath, 'utf8'), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    });

    // 端点恢复后，超过内存短驻 TTL 的下一次请求重新拉取成功。
    apiAvailable = true;
    currentTime += PROVIDER_MODELS_FALLBACK_TTL_MS + 1;

    const recovered = await service.getProviderModels('codex');
    assert.equal(recovered.models.DEFAULT, 'recovered-catalog');
    assert.equal(recovered.cache.source, 'fresh');
    assert.equal(loadCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('R21: concurrent requests with the same fingerprint share one fetch', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-inflight-fp-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { models: createModels('shared-fingerprint-catalog'), fingerprint: 'fp-shared', cacheable: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const [first, second] = await Promise.all([
      service.getProviderModels('codex'),
      service.getProviderModels('codex'),
    ]);

    assert.equal(loadCount, 1);
    assert.equal(first.models.DEFAULT, 'shared-fingerprint-catalog');
    assert.equal(second.models.DEFAULT, 'shared-fingerprint-catalog');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('R22: the persisted cache file never contains the raw credential', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-no-secret-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  const secret = 'sk-super-secret-credential';

  try {
    const service = createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => ({
            models: createModels('configured-catalog'),
            fingerprint: computeModelsFingerprint({
              baseUrl: 'https://aiapi.tcredit.com/v1',
              credential: secret,
              modelProvider: 'tc-credit',
              model: 'gpt-5.6-sol',
            }),
            cacheable: true,
          }),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    await service.getProviderModels('codex');

    const raw = await readFile(cachePath, 'utf8');
    assert.ok(!raw.includes(secret));
    assert.ok(raw.includes('codex:'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('R23: an unchanged fingerprint reuses the cached catalog without loading the facet', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-fingerprint-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  let loadCount = 0;

  try {
    const makeService = () => createProviderModelsService({
      assertProviderAuthenticated: async () => undefined,
      cachePath,
      resolveProvider: (provider) => ({
        models: {
          getCachedCatalogFingerprint: () => 'fp-stable',
          getSupportedModels: async () => {
            loadCount += 1;
            return { models: createModels('configured-catalog'), fingerprint: 'fp-stable', cacheable: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const service = makeService();
    const first = await service.getProviderModels('codex');
    assert.equal(first.cache.source, 'fresh');

    const memoryHit = await service.getProviderModels('codex');
    assert.equal(memoryHit.cache.source, 'memory');
    assert.equal(memoryHit.models.DEFAULT, 'configured-catalog');
    assert.equal(loadCount, 1);

    // 新实例读磁盘缓存，同样不触发 facet。
    const diskHit = await makeService().getProviderModels('codex');
    assert.equal(diskHit.cache.source, 'disk');
    assert.equal(loadCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
