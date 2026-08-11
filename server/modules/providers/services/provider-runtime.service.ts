import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { ProviderRunCoordinator } from '@/modules/providers/services/provider-run-coordinator.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { normalizeAttachmentDescriptors } from '@/shared/image-attachments.js';
import type {
  IProviderSessionIdentityStore,
  ProviderDefinition,
} from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRunOutcome,
  ProviderRunFunction,
  ProviderRunRequest,
  ProviderRunToolSettings,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { AppError, generateMessageId } from '@/shared/utils.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): ProviderDefinition[];
  resolveProvider(provider: string): ProviderDefinition;
  resolveProviderSessionId(
    sessionId: string | null | undefined,
    provider: LLMProvider,
  ): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  recordSessionModel(
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): void;
  createRunId(): string;
  sessionIdentity: IProviderSessionIdentityStore;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId, provider) =>
    sessionsService.resolveProviderSessionId(sessionId, provider),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider, options) => providerModelsService.getProviderModels(provider, options),
  recordSessionModel: (provider, sessionId, model) => {
    // The auth gate makes this call asynchronous; an unauthenticated run would
    // fail later in the runtime anyway, so swallow the gate error here rather
    // than let it surface as an unhandled rejection on every chat.send. Any
    // other failure means the session row was not persisted — log it instead of
    // dropping it silently, without blocking the run.
    void providerModelsService.setSessionModel(provider, sessionId, model).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'PROVIDER_NOT_AUTHENTICATED') {
        return undefined;
      }
      console.warn('Unable to record session model:', error);
    });
  },
  createRunId: () => generateMessageId('run'),
  sessionIdentity: sessionsService,
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function projectToolSettings(value: unknown): ProviderRunToolSettings | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const settings = value as AnyRecord;
  return {
    allowedTools: readStringList(settings.allowedTools),
    disallowedTools: readStringList(settings.disallowedTools),
    allowedShellCommands: readStringList(settings.allowedShellCommands),
    skipPermissions: readOptionalBoolean(settings.skipPermissions),
  };
}

function projectAttachments(value: unknown) {
  return Array.isArray(value) ? normalizeAttachmentDescriptors(value) : undefined;
}

function readUserId(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. The Agent and WebSocket
 * modules share the production singleton assembled from this factory; their
 * module tests create isolated instances with fake typed runtimes. This service
 * supplies registry-backed model/session lookups at execution time so runtime
 * adapters never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const coordinator = new ProviderRunCoordinator({
    createRunId: dependencies.createRunId,
    resolveProvider: dependencies.resolveProvider,
    sessionIdentity: dependencies.sessionIdentity,
    recordSessionModel: dependencies.recordSessionModel,
  });

  const createRuntimeContext = (
    provider: ProviderDefinition,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: (sessionId) =>
      dependencies.resolveProviderSessionId(sessionId, provider.id),
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () =>
      (await dependencies.getProviderModels(provider.id)).models,
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<ProviderRunOutcome> => {
    const provider = dependencies.resolveProvider(providerName);
    const suppliedAppSessionId = readOptionalString(options.sessionId);
    const appSessionId = suppliedAppSessionId ?? generateMessageId('session');
    const explicitProviderSessionId = options.providerSessionId === null
      ? null
      : readOptionalString(options.providerSessionId);
    const providerSessionId = explicitProviderSessionId !== undefined
      ? explicitProviderSessionId
      : (suppliedAppSessionId
        ? dependencies.resolveProviderSessionId(suppliedAppSessionId, providerName)
        : null);
    const request: Omit<ProviderRunRequest, 'runId'> = {
      provider: providerName,
      appSessionId,
      providerSessionId,
      command,
      cwd: readOptionalString(options.cwd),
      projectPath: readOptionalString(options.projectPath),
      artifactPath: options.artifactPath === null
        ? null
        : readOptionalString(options.artifactPath),
      model: readOptionalString(options.model),
      effort: readOptionalString(options.effort),
      permissionMode: readOptionalString(options.permissionMode),
      sessionSummary: readOptionalString(options.sessionSummary),
      images: projectAttachments(options.images),
      files: projectAttachments(options.files),
      attachments: projectAttachments(options.attachments),
      toolsSettings: projectToolSettings(options.toolsSettings),
      skipPermissions: readOptionalBoolean(options.skipPermissions),
      userId: readUserId(writer.userId ?? options.userId),
    };

    return coordinator.run(request, writer, createRuntimeContext(provider));
  };

  const abortRun = async (appSessionId: string): Promise<boolean> =>
    coordinator.abortRun(appSessionId);

  return {
    run,

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    abortRun,

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      dependencies.resolveProvider(providerName);
      return abortRun(sessionId);
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
