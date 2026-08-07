import type { LLMProvider, ProviderModelsDefinition } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import { DEFAULT_EFFORT_VALUE } from '../constants/providerEffort';

import type { QueuedSendOptions } from './chatStorage';

type CapabilitiesResponse = {
  success?: boolean;
  data?: {
    providers?: Array<{
      provider?: LLMProvider;
      permissionModes?: unknown;
      supportsEffort?: unknown;
    }>;
  };
};

type ModelsResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
  };
};

type ActiveModelResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string | null;
    model?: string | null;
    source?: 'session' | 'provider' | 'default';
  };
};

type ResolveQueuedSendOptionsArgs = {
  provider: LLMProvider;
  sessionId: string;
  options?: QueuedSendOptions;
};

const readNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim() || null;
};

/**
 * Re-resolves persisted queue options against current backend state. A local
 * snapshot is never sufficient authority to send after an asynchronous gap.
 */
export async function resolveQueuedSendOptions({
  provider,
  sessionId,
  options,
}: ResolveQueuedSendOptionsArgs): Promise<QueuedSendOptions | null> {
  const permissionMode = readNonEmptyString(options?.permissionMode);
  const queuedModel = readNonEmptyString(options?.model);
  const queuedEffort = readNonEmptyString(options?.effort) ?? DEFAULT_EFFORT_VALUE;
  if (!permissionMode || !queuedModel) {
    return null;
  }

  try {
    const [capabilitiesResponse, modelsResponse, activeModelResponse] = await Promise.all([
      authenticatedFetch('/api/providers/capabilities'),
      authenticatedFetch(`/api/providers/${provider}/models`),
      authenticatedFetch(
        `/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`,
      ),
    ]);
    const [capabilitiesBody, modelsBody, activeModelBody] = await Promise.all([
      capabilitiesResponse.json() as Promise<CapabilitiesResponse>,
      modelsResponse.json() as Promise<ModelsResponse>,
      activeModelResponse.json() as Promise<ActiveModelResponse>,
    ]);

    if (
      !capabilitiesResponse.ok
      || !modelsResponse.ok
      || !activeModelResponse.ok
      || !capabilitiesBody.success
      || !modelsBody.success
      || !activeModelBody.success
    ) {
      return null;
    }

    const capabilities = capabilitiesBody.data?.providers?.find((entry) => entry.provider === provider);
    const permissionModes = Array.isArray(capabilities?.permissionModes)
      ? capabilities.permissionModes.filter((mode): mode is string => typeof mode === 'string')
      : [];
    if (!permissionModes.includes(permissionMode)) {
      return null;
    }

    const models = modelsBody.data?.models;
    if (!models || !Array.isArray(models.OPTIONS)) {
      return null;
    }
    const catalogModels = models.OPTIONS
      .map((option) => readNonEmptyString(option?.value))
      .filter((model): model is string => Boolean(model));

    const activeData = activeModelBody.data;
    const activeModel = readNonEmptyString(activeData?.model);
    const activeModelSource = activeData?.source;
    const isExplicitActiveModel = activeModelSource === 'session' || activeModelSource === 'provider';
    if (
      !activeData
      || activeData.provider !== provider
      || activeData.sessionId !== sessionId
      || !activeModel
      || (!catalogModels.includes(activeModel) && !isExplicitActiveModel)
    ) {
      return null;
    }

    let resolvedModel: string | null = null;
    if (isExplicitActiveModel) {
      resolvedModel = activeModel;
    } else if (activeData.source === 'default' && catalogModels.includes(queuedModel)) {
      resolvedModel = queuedModel;
    }
    if (!resolvedModel) {
      return null;
    }

    let resolvedEffort = DEFAULT_EFFORT_VALUE;
    if (capabilities?.supportsEffort === true) {
      const resolvedModelOption = models.OPTIONS.find(
        (option) => readNonEmptyString(option?.value) === resolvedModel,
      );
      if (resolvedModelOption) {
        const allowedEfforts = Array.isArray(resolvedModelOption.effort?.values)
          ? resolvedModelOption.effort.values
              .map((entry) => readNonEmptyString(entry?.value))
              .filter((effort): effort is string => Boolean(effort))
          : [];
        resolvedEffort = queuedEffort === DEFAULT_EFFORT_VALUE || allowedEfforts.includes(queuedEffort)
          ? queuedEffort
          : DEFAULT_EFFORT_VALUE;
      }
    } else if (capabilities?.supportsEffort !== false && queuedEffort !== DEFAULT_EFFORT_VALUE) {
      return null;
    }

    return {
      ...options,
      model: resolvedModel,
      effort: resolvedEffort,
      permissionMode,
    };
  } catch (error) {
    console.error('Error validating queued send options:', error);
    return null;
  }
}
