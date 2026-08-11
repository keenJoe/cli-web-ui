/**
 * Temporary bridge for the four JavaScript provider runtimes.
 *
 * Exit is tracked by OpenSpec task 4.6 and
 * `openspec/changes/refactor-provider-seams/legacy-runtime-adapter-exit.md`:
 * delete this adapter after Claude, Codex, Cursor, and OpenCode are TypeScript
 * runtimes that implement `IProviderRuntime` directly.
 */

import type {
  IProviderEventSink,
  IProviderRuntime,
} from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderRunEvent,
  ProviderRunOutcome,
  ProviderRunRequest,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

type LegacyProviderRuntime = {
  run(
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown> | unknown;
  abort(sessionId: string): Promise<boolean> | boolean;
  permissions?: ProviderRuntimePermissionGateway;
};

type LegacyMessage = Record<string, unknown> & {
  kind?: unknown;
};

function decodeLegacyMessage(data: unknown): LegacyMessage | null {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed !== null && typeof parsed === 'object'
        ? parsed as LegacyMessage
        : null;
    } catch {
      return null;
    }
  }

  return data !== null && typeof data === 'object'
    ? data as LegacyMessage
    : null;
}

function createLegacyOptions(request: ProviderRunRequest, signal: AbortSignal): AnyRecord {
  return {
    sessionId: request.appSessionId,
    providerSessionId: request.providerSessionId,
    runId: request.runId,
    signal,
    cwd: request.cwd,
    projectPath: request.projectPath,
    artifactPath: request.artifactPath,
    model: request.model,
    effort: request.effort,
    permissionMode: request.permissionMode,
    sessionSummary: request.sessionSummary,
    images: request.images,
    files: request.files,
    attachments: request.attachments,
    toolsSettings: request.toolsSettings,
    skipPermissions: request.skipPermissions,
  };
}

/**
 * Adapts staged JavaScript runtimes for provider aggregates and coordinator
 * contract tests while keeping terminal lifecycle ownership in the application.
 */
export class LegacyProviderRuntimeAdapter implements IProviderRuntime {
  readonly permissions?: ProviderRuntimePermissionGateway;

  constructor(private readonly legacyRuntime: LegacyProviderRuntime) {
    this.permissions = legacyRuntime.permissions;
  }

  run(
    request: ProviderRunRequest,
    sink: IProviderEventSink,
    context: ProviderRuntimeContext,
    signal: AbortSignal,
  ): Promise<ProviderRunOutcome> {
    if (signal.aborted) {
      return Promise.resolve({
        status: 'aborted',
        providerSessionId: request.providerSessionId,
        exitCode: 1,
      });
    }

    let providerSessionId = request.providerSessionId;
    let settled = false;
    let resolveOutcome!: (outcome: ProviderRunOutcome) => void;
    const outcomePromise = new Promise<ProviderRunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const settle = (outcome: ProviderRunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      resolveOutcome(outcome);
    };

    const bindProviderSession = (
      candidate: unknown,
      artifactPath?: string | null,
      authoritative = false,
    ): void => {
      if (
        settled
        || providerSessionId !== null
        || typeof candidate !== 'string'
        || candidate.length === 0
        || (!authoritative && candidate === request.appSessionId)
      ) {
        return;
      }

      providerSessionId = candidate;
      sink.bindProviderSession({ providerSessionId: candidate, artifactPath });
    };

    const handleLegacyMessage = (data: unknown): void => {
      if (settled) {
        return;
      }

      const message = decodeLegacyMessage(data);
      if (!message || typeof message.kind !== 'string') {
        return;
      }

      if (message.kind === 'session_created') {
        const hasExplicitNativeId = typeof message.newSessionId === 'string';
        bindProviderSession(
          hasExplicitNativeId
            ? message.newSessionId
            : message.sessionId,
          typeof message.artifactPath === 'string' ? message.artifactPath : undefined,
          hasExplicitNativeId,
        );
        return;
      }

      if (message.kind === 'complete') {
        const terminalSessionId = typeof message.actualSessionId === 'string'
          ? message.actualSessionId
          : message.sessionId;
        bindProviderSession(terminalSessionId);

        const hasExplicitTerminalStatus = (
          (typeof message.exitCode === 'number' && Number.isFinite(message.exitCode))
          || typeof message.success === 'boolean'
          || message.aborted === true
        );
        // Legacy normalizers can surface upstream completion markers before
        // the runtime emits its authoritative process outcome.
        if (!hasExplicitTerminalStatus && !signal.aborted) {
          return;
        }

        const exitCode = typeof message.exitCode === 'number' && Number.isFinite(message.exitCode)
          ? message.exitCode
          : 1;
        if (message.aborted === true || signal.aborted) {
          settle({ status: 'aborted', providerSessionId, exitCode });
        } else if (exitCode === 0 && message.success !== false) {
          settle({ status: 'completed', providerSessionId, exitCode: 0 });
        } else {
          settle({
            status: 'failed',
            providerSessionId,
            exitCode,
            errorCode: typeof message.errorCode === 'string' ? message.errorCode : undefined,
            error: message.error,
          });
        }
        return;
      }

      const event = createNormalizedMessage({
        ...message,
        kind: message.kind as ProviderRunEvent['kind'],
        provider: request.provider,
        sessionId: request.appSessionId,
      }) as ProviderRunEvent;
      sink.emit(event);
    };

    const legacyWriter: ProviderRuntimeWriter = {
      send: handleLegacyMessage,
      setSessionId: (sessionId) => bindProviderSession(sessionId, undefined, true),
      userId: request.userId,
      isWebSocketWriter: true,
    };

    function handleAbort(): void {
      settle({ status: 'aborted', providerSessionId, exitCode: 1 });
      try {
        void Promise.resolve(legacyRuntime.abort(request.appSessionId)).catch(() => undefined);
      } catch {
        // Coordinator cancellation has already won; legacy cleanup is best effort.
      }
    }

    const { legacyRuntime } = this;
    const legacyContext: ProviderRuntimeContext = {
      ...context,
      resolveProviderSessionId(sessionId) {
        if (sessionId === request.appSessionId) {
          return request.providerSessionId;
        }
        return context.resolveProviderSessionId(sessionId);
      },
    };
    signal.addEventListener('abort', handleAbort, { once: true });

    const runtimePromise = Promise.resolve().then(() => {
      if (signal.aborted) {
        return;
      }

      return legacyRuntime.run(
        request.command,
        createLegacyOptions(request, signal),
        legacyWriter,
        legacyContext,
      );
    });
    void runtimePromise.then(
      () => settle({ status: 'failed', providerSessionId, exitCode: 1 }),
      (error: unknown) => {
        if (signal.aborted) {
          settle({ status: 'aborted', providerSessionId, exitCode: 1 });
          return;
        }
        settle({ status: 'failed', providerSessionId, exitCode: 1, error });
      },
    );

    return outcomePromise;
  }
}
