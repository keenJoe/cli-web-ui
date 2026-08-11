import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { useProviderCapabilities } from '../../../hooks/useProviderCapabilities';
import { PROVIDER_IDS } from '../../llm-logo-provider/providerBranding';
import { useProviderAuthStatus } from '../../provider-auth/hooks/useProviderAuthStatus';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelOption,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
  ProviderCapabilityStatus,
} from '../../../types/app';
import { DEFAULT_EFFORT_VALUE } from '../constants/providerEffort';
import { resolveProviderModelSelection } from '../utils/providerModelSelection';

const readStoredProvider = (): LLMProvider => {
  const storedProvider = localStorage.getItem('selected-provider');
  return PROVIDER_IDS.includes(storedProvider as LLMProvider)
    ? storedProvider as LLMProvider
    : 'claude';
};

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
}

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
    cache?: ProviderModelsCacheInfo;
  };
};

type SessionModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string | null;
    model?: string | null;
    /**
     * `session` and `provider` are real answers for this session; `default`
     * means the backend had nothing recorded and returned the catalog default,
     * which the composer replaces with the user's per-provider selection.
     */
    source?: 'session' | 'provider' | 'default';
  };
};

type SessionModelState = {
  key: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  model: string | null;
  source: 'session' | 'provider' | 'default' | null;
};

const getSessionModelKey = (provider: LLMProvider, sessionId: string) => `${provider}:${sessionId}`;

export function useChatProviderState({ selectedSession, selectedProject: _selectedProject }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<LLMProvider>(readStoredProvider);
  const [providerModels, setProviderModels] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDER_IDS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      const storedModel = localStorage.getItem(`${targetProvider}-model`)?.trim();
      if (storedModel) {
        acc[targetProvider] = storedModel;
      }
      return acc;
    }, {});
  });
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDER_IDS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });

  const {
    status: capabilitiesStatus,
    byProvider: providerCapabilities,
  } = useProviderCapabilities();

  // Subscribe to the shared auth store so status changes made in settings or
  // onboarding reach the chat page without a full page reload.
  const { providerAuthStatus } = useProviderAuthStatus();

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);

  const providerModelsRequestIdRef = useRef(0);

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    setProviderModels((previous) => (
      previous[targetProvider] === model
        ? previous
        : { ...previous, [targetProvider]: model }
    ));
    localStorage.setItem(`${targetProvider}-model`, model);
  }, []);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(`${targetProvider}-effort`, effort);
  }, []);

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    try {
      const results = await Promise.all(
        PROVIDER_IDS.map(async (p) => {
          try {
            const params = new URLSearchParams();
            if (options.bypassCache) {
              params.set('bypassCache', 'true');
            }

            const queryString = params.toString();
            const response = await authenticatedFetch(`/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`);
            const body = (await response.json()) as ProviderModelsApiResponse;
            if (!body.success || !body.data?.models || !body.data?.cache) {
              return null;
            }

            return body.data;
          } catch (error) {
            console.error(`Error loading models for provider "${p}":`, error);
            return null;
          }
        }),
      );

      if (providerModelsRequestIdRef.current !== requestId) {
        return;
      }

      const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
      const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};

      PROVIDER_IDS.forEach((p, i) => {
        const entry = results[i];
        if (!entry) {
          return;
        }

        nextCatalog[p] = entry.models;
        nextCacheCatalog[p] = entry.cache;
      });

      setProviderModelCatalog(nextCatalog);
      setProviderModelCacheCatalog(nextCacheCatalog);
    } catch (error) {
      console.error('Error loading provider models:', error);
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
        setProviderModelsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  // Derived auth state for the active provider. The model menu is fully hidden
  // only when the provider is definitively unauthenticated (check finished, no
  // credentials, CLI installed); while the check is still running or failed it
  // stays visible as a disabled skeleton so the user sees progress, not a
  // vanishing control.
  const currentProviderAuthStatus = providerAuthStatus[provider];
  const modelMenuAvailable = !currentProviderAuthStatus.loading && currentProviderAuthStatus.authenticated;
  const modelMenuHidden = !currentProviderAuthStatus.loading
    && !currentProviderAuthStatus.authenticated
    && currentProviderAuthStatus.installed;

  // A login elsewhere (settings/onboarding) flips the shared store; the models
  // fetched while unauthenticated fail the backend gate, so a false→true flip
  // must refetch instead of waiting for a manual refresh.
  const wasProviderAuthenticatedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const wasAuthenticated = wasProviderAuthenticatedRef.current;
    wasProviderAuthenticatedRef.current = modelMenuAvailable;
    if (wasAuthenticated === false && modelMenuAvailable) {
      void loadProviderModels();
    }
  }, [loadProviderModels, modelMenuAvailable]);

  const getCapabilityStatusForProvider = useCallback((targetProvider: LLMProvider): ProviderCapabilityStatus => {
    if (capabilitiesStatus !== 'ready') {
      return capabilitiesStatus;
    }
    return providerCapabilities[targetProvider] ? 'ready' : 'error';
  }, [capabilitiesStatus, providerCapabilities]);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    if (getCapabilityStatusForProvider(targetProvider) !== 'ready') {
      return [];
    }

    const capabilityModes = providerCapabilities[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return [];
  }, [getCapabilityStatusForProvider, providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode | null => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return null;
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    if (getCapabilityStatusForProvider(targetProvider) !== 'ready') {
      return false;
    }

    return providerCapabilities[targetProvider]?.supportsEffort === true;
  }, [getCapabilityStatusForProvider, providerCapabilities]);

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    const definition = providerModelCatalog[targetProvider];
    if (!definition) {
      return null;
    }

    return definition.OPTIONS.find((option) => option.value === model) ?? null;
  }, [providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return [];
  }, [getModelOption, getSupportsEffortForProvider]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    if (getCapabilityStatusForProvider(targetProvider) !== 'ready') {
      return currentEffort;
    }

    const supportsEffort = providerCapabilities[targetProvider]?.supportsEffort;
    if (supportsEffort !== true) {
      return DEFAULT_EFFORT_VALUE;
    }

    const definition = providerModelCatalog[targetProvider];
    const option = definition?.OPTIONS.find((candidate) => candidate.value === model);
    if (!definition || !option) {
      return currentEffort;
    }

    const allowedValues = option.effort?.values.map((value) => value.value) ?? [];
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getCapabilityStatusForProvider, providerCapabilities, providerModelCatalog]);

  useEffect(() => {
    const nextModels: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDER_IDS) {
      const definition = providerModelCatalog[targetProvider];
      if (!definition) {
        continue;
      }

      const storageKey = `${targetProvider}-model`;
      const currentModel = providerModels[targetProvider];
      const next = resolveProviderModelSelection(
        definition,
        localStorage.getItem(storageKey),
        currentModel,
      );
      if (!next) {
        continue;
      }
      if (next !== currentModel) {
        nextModels[targetProvider] = next;
        hasUpdates = true;
      }
      if (localStorage.getItem(storageKey) !== next) {
        localStorage.setItem(storageKey, next);
      }
    }

    if (hasUpdates) {
      setProviderModels((previous) => ({ ...previous, ...nextModels }));
    }
  }, [providerModelCatalog, providerModels]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDER_IDS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const currentModel = providerModels[targetProvider] ?? '';
      const nextEffort = reconcileStoredEffort(targetProvider, currentModel, currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(`${targetProvider}-effort`, nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  useEffect(() => {
    const validModes = getPermissionModesForProvider(provider);
    if (validModes.length === 0) {
      setPermissionMode(null);
      return;
    }

    const sessionSavedMode = selectedSession?.id
      ? (localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null)
      : null;
    // Fall back to the last mode picked for this provider: a brand-new chat
    // only receives its session id after the first send, so without this the
    // mode chosen beforehand would snap back to the default as soon as the
    // session id appears.
    const providerSavedMode = localStorage.getItem(`permissionMode-last-${provider}`) as PermissionMode | null;
    const savedMode = [sessionSavedMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(provider));
  }, [selectedSession?.id, provider, getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  const selectPermissionMode = useCallback((nextMode: PermissionMode) => {
    if (!getPermissionModesForProvider(provider).includes(nextMode)) {
      return;
    }

    setPermissionMode(nextMode);

    // Persist per provider as well as per session: a brand-new chat has no
    // session id yet, and the per-provider key keeps the choice sticky when
    // the real id arrives (and for future sessions of this provider).
    localStorage.setItem(`permissionMode-last-${provider}`, nextMode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [getPermissionModesForProvider, provider, selectedSession?.id]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);
    if (modes.length === 0) {
      return;
    }

    const currentIndex = permissionMode ? modes.indexOf(permissionMode) : -1;
    const nextIndex = (currentIndex + 1) % modes.length;
    selectPermissionMode(modes[nextIndex]);
  }, [permissionMode, provider, getPermissionModesForProvider, selectPermissionMode]);

  const availablePermissionModes = useMemo(
    () => getPermissionModesForProvider(provider),
    [getPermissionModesForProvider, provider],
  );

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode | null => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  /**
   * Model the open session runs with, as reported by the backend. Null while no
   * session is open, or when the backend has nothing recorded for it and only
   * offered the catalog default — the per-provider selection covers that case.
   */
  const sessionModelProvider = selectedSession?.__provider ?? provider;
  const sessionModelId = selectedSession?.id ?? null;
  const sessionModelKey = sessionModelId
    ? getSessionModelKey(sessionModelProvider, sessionModelId)
    : null;
  const [sessionModelState, setSessionModelState] = useState<SessionModelState>({
    key: null,
    status: 'idle',
    model: null,
    source: null,
  });

  useEffect(() => {
    if (!sessionModelId || !sessionModelKey) {
      setSessionModelState((previous) => (
        previous.key === null
        && previous.status === 'idle'
        && previous.model === null
        && previous.source === null
          ? previous
          : { key: null, status: 'idle', model: null, source: null }
      ));
      return;
    }

    let cancelled = false;
    setSessionModelState({ key: sessionModelKey, status: 'loading', model: null, source: null });

    const loadSessionModel = async () => {
      try {
        const response = await authenticatedFetch(
          `/api/providers/${sessionModelProvider}/sessions/${encodeURIComponent(sessionModelId)}/active-model`,
        );
        const body = (await response.json()) as SessionModelApiResponse;
        if (cancelled) {
          return;
        }
        const data = body.data;
        const source = data?.source;
        const resolvedModel = data?.model?.trim();
        if (
          !response.ok
          || !body.success
          || !data
          || data.provider !== sessionModelProvider
          || data.sessionId !== sessionModelId
          || (source !== 'session' && source !== 'provider' && source !== 'default')
          || !resolvedModel
        ) {
          throw new Error(`Active model request failed (${response.status})`);
        }

        setSessionModelState({
          key: sessionModelKey,
          status: 'ready',
          model: source !== 'default' ? resolvedModel : null,
          source,
        });
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading the session model:', error);
          setSessionModelState({ key: sessionModelKey, status: 'error', model: null, source: null });
        }
      }
    };

    void loadSessionModel();
    return () => {
      cancelled = true;
    };
  }, [sessionModelId, sessionModelKey, sessionModelProvider]);

  /**
   * Applies a model choice.
   *
   * The pick always becomes the per-provider default so the next new chat
   * inherits it, and — when a session is open — is also recorded against that
   * session so reopening it later restores this model.
   */
  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    setStoredProviderModel(targetProvider, model);

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return { scope: 'default' as const, model };
    }

    const response = await authenticatedFetch(
      `/api/providers/${targetProvider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
      },
    );

    const body = (await response.json()) as SessionModelApiResponse;
    if (!response.ok || !body.success) {
      throw new Error('Unable to change the active model for this session.');
    }

    const storedModel = body.data?.model?.trim() || model;
    setSessionModelState({
      key: getSessionModelKey(targetProvider, normalizedSessionId),
      status: 'ready',
      model: storedModel,
      source: 'session',
    });
    return { scope: 'session' as const, model: storedModel };
  }, [setStoredProviderModel]);

  // The open session's model wins over the per-provider default, so switching
  // sessions shows (and sends) what each session actually runs with.
  const providerCapabilityStatus = getCapabilityStatusForProvider(provider);
  const supportsSkills = providerCapabilityStatus === 'ready'
    && providerCapabilities[provider]?.supportsSkills === true;
  const supportsTokenUsage = providerCapabilityStatus === 'ready'
    && providerCapabilities[provider]?.supportsTokenUsage === true;
  const catalogProviderModel = useMemo(() => {
    const definition = providerModelCatalog[provider];
    if (!definition) {
      return null;
    }

    return resolveProviderModelSelection(definition, providerModels[provider]);
  }, [provider, providerModelCatalog, providerModels]);
  const isSessionModelReady = sessionModelKey === null || (
    sessionModelState.key === sessionModelKey && sessionModelState.status === 'ready'
  );
  const resolvedSessionModel = sessionModelKey === null ? null : sessionModelState.model;
  const currentProviderModel = providerCapabilityStatus === 'ready'
    && isSessionModelReady
    ? resolvedSessionModel ?? catalogProviderModel
    : null;
  const currentProviderEffortOptions = useMemo(() => {
    if (!currentProviderModel) {
      return [];
    }
    return getEffortOptionsForModel(provider, currentProviderModel);
  }, [currentProviderModel, getEffortOptionsForModel, provider]);
  const currentProviderEffort = useMemo(() => {
    if (!currentProviderModel) {
      return DEFAULT_EFFORT_VALUE;
    }
    return reconcileStoredEffort(
      provider,
      currentProviderModel,
      providerEfforts[provider] ?? DEFAULT_EFFORT_VALUE,
    );
  }, [currentProviderModel, provider, providerEfforts, reconcileStoredEffort]);
  const currentProviderModelOptions = useMemo(() => {
    const definition = providerModelCatalog[provider];
    const catalogOptions = definition?.OPTIONS ?? [];
    if (
      !definition
      || catalogOptions.length === 0
      || !currentProviderModel
      || catalogOptions.some((option) => option.value === currentProviderModel)
    ) {
      return catalogOptions;
    }

    // Keep an explicitly selected model visible while the loaded provider
    // catalog is stale. It is intentionally metadata-light: effort controls
    // remain hidden until the provider advertises the model.
    return [
      ...catalogOptions,
      { value: currentProviderModel, label: currentProviderModel },
    ];
  }, [currentProviderModel, provider, providerModelCatalog]);

  return {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode: providerCapabilityStatus === 'ready' ? permissionMode : null,
    providerCapabilityStatus,
    supportsSkills,
    supportsTokenUsage,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    providerAuthStatus,
    modelMenuAvailable,
    modelMenuHidden,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  };
}
