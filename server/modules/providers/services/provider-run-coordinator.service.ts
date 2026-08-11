import type {
  IProviderEventSink,
  IProviderSessionIdentityStore,
  ProviderDefinition,
} from '@/shared/interfaces.js';
import type {
  ProviderRunOutcome,
  ProviderRunRequest,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  AppError,
  createCompleteMessage,
  createNormalizedMessage,
  generateMessageId,
} from '@/shared/utils.js';

type ProviderRunCoordinatorDependencies = {
  readonly createRunId?: () => string;
  readonly resolveProvider: (provider: string) => ProviderDefinition;
  readonly sessionIdentity?: IProviderSessionIdentityStore;
  readonly recordSessionModel?: (
    provider: ProviderRunRequest['provider'],
    sessionId: string,
    model: string,
  ) => void;
};

type RunState = 'running' | 'completed' | 'aborted' | 'failed';

type ActiveRun = {
  readonly runId: string;
  readonly request: ProviderRunRequest;
  readonly writer: ProviderRuntimeWriter;
  readonly abortController: AbortController;
  readonly resolveOutcome: (outcome: ProviderRunOutcome) => void;
  readonly persistsSessionIdentity: boolean;
  state: RunState;
  providerSessionId: string | null;
};

/**
 * Owns provider run identity, cancellation, and exactly-one terminal emission.
 *
 * `providerRuntimeService` uses this coordinator as the application boundary
 * for every registered runtime. Provider contract tests also construct it with
 * fake definitions to verify R10-R12 without a transport or native process.
 * Events are forwarded immediately to the supplied compatibility writer; the
 * existing WebSocket run registry remains the sole replay buffer.
 */
export class ProviderRunCoordinator {
  private readonly activeRuns = new Map<string, ActiveRun>();

  private readonly createRunId: () => string;

  constructor(private readonly dependencies: ProviderRunCoordinatorDependencies) {
    this.createRunId = dependencies.createRunId ?? (() => generateMessageId('run'));
  }

  /** Starts one typed run and resolves as soon as its first terminal state wins. */
  run(
    request: Omit<ProviderRunRequest, 'runId'>,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<ProviderRunOutcome> {
    let provider: ProviderDefinition;
    try {
      provider = this.dependencies.resolveProvider(request.provider);
    } catch (error) {
      return Promise.reject(error);
    }

    const currentRun = this.activeRuns.get(request.appSessionId);
    if (currentRun?.state === 'running') {
      return Promise.reject(new AppError(
        `A provider run is already active for session "${request.appSessionId}".`,
        {
          code: 'RUN_IN_PROGRESS',
          statusCode: 409,
        },
      ));
    }

    const projectPath = request.projectPath?.trim();
    let persistsSessionIdentity = false;
    if (
      request.providerSessionId === null
      && projectPath
      && this.dependencies.sessionIdentity
    ) {
      try {
        this.dependencies.sessionIdentity.ensureAppSession(
          request.appSessionId,
          request.provider,
          projectPath,
        );
        persistsSessionIdentity = true;
      } catch (error) {
        return Promise.reject(error);
      }
    }

    // Agent HTTP allocates its app row inside this coordinator. Persist an
    // explicit model after any fresh-row ensure/ownership check and before the
    // runtime starts, so a browser can restore the exact selection after a
    // reload. The same rule applies to resume runs: a later explicit choice
    // must replace the previous session model just like WebSocket chat.send.
    // Direct provider callers that supply only a native id and no project path
    // have no app-owned row to update, so leave those legacy runs untouched.
    if (
      request.model?.trim()
      && (persistsSessionIdentity || projectPath)
      && this.dependencies.recordSessionModel
    ) {
      try {
        this.dependencies.recordSessionModel(
          request.provider,
          request.appSessionId,
          request.model.trim(),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }

    let resolveOutcome!: (outcome: ProviderRunOutcome) => void;
    const outcomePromise = new Promise<ProviderRunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const runId = this.createRunId();
    const activeRun: ActiveRun = {
      runId,
      request: {
        ...request,
        runId,
      },
      writer,
      abortController: new AbortController(),
      resolveOutcome,
      persistsSessionIdentity,
      state: 'running',
      providerSessionId: request.providerSessionId,
    };
    this.activeRuns.set(request.appSessionId, activeRun);

    const sink = this.createEventSink(activeRun);
    const runtimePromise = Promise.resolve().then(() => provider.runtime.run(
      activeRun.request,
      sink,
      context,
      activeRun.abortController.signal,
    ));

    // Attach both branches before exposing the run promise so a late rejection
    // after abort can never become an unhandled rejection.
    void runtimePromise.then(
      (outcome) => this.acceptRuntimeOutcome(activeRun, outcome),
      (error: unknown) => this.acceptRuntimeFailure(activeRun, error),
    );

    return outcomePromise.finally(() => {
      if (this.activeRuns.get(request.appSessionId) === activeRun) {
        this.activeRuns.delete(request.appSessionId);
      }
    });
  }

  /** Aborts the current generation for an app session, when one is running. */
  abortRun(appSessionId: string): boolean {
    const activeRun = this.activeRuns.get(appSessionId);
    if (!activeRun || activeRun.state !== 'running') {
      return false;
    }

    const outcome: ProviderRunOutcome = {
      status: 'aborted',
      providerSessionId: activeRun.providerSessionId,
      exitCode: 1,
    };

    // Fix the terminal state before dispatching AbortSignal. Abort listeners
    // may synchronously schedule provider cleanup or a competing outcome.
    activeRun.state = 'aborted';
    activeRun.abortController.abort();
    this.emitTerminal(activeRun, outcome);
    return true;
  }

  /** Compatibility alias retained for provider contract and characterization tests. */
  abort(appSessionId: string): boolean {
    return this.abortRun(appSessionId);
  }

  private createEventSink(activeRun: ActiveRun): IProviderEventSink {
    return {
      bindProviderSession: (binding) => {
        if (
          !this.isCurrentRunning(activeRun)
          || activeRun.providerSessionId !== null
          || binding.providerSessionId.length === 0
        ) {
          return;
        }

        if (!this.bindProviderSession(activeRun, binding.providerSessionId)) {
          return;
        }
        this.write(activeRun, () => {
          activeRun.writer.send(createNormalizedMessage({
            kind: 'session_created',
            provider: activeRun.request.provider,
            sessionId: activeRun.request.appSessionId,
            newSessionId: binding.providerSessionId,
            artifactPath: binding.artifactPath ?? null,
          }));
        });
      },
      emit: (event) => {
        if (!this.isCurrentRunning(activeRun)) {
          return;
        }

        this.write(activeRun, () => {
          activeRun.writer.send({
            ...event,
            provider: activeRun.request.provider,
            sessionId: activeRun.request.appSessionId,
          });
        });
      },
    };
  }

  private acceptRuntimeOutcome(activeRun: ActiveRun, outcome: ProviderRunOutcome): void {
    if (!this.isCurrentRunning(activeRun)) {
      return;
    }

    if (activeRun.providerSessionId === null && outcome.providerSessionId) {
      if (!this.bindProviderSession(activeRun, outcome.providerSessionId)) {
        return;
      }
    }

    const normalizedOutcome = this.normalizeOutcome(activeRun, outcome);
    activeRun.state = normalizedOutcome.status;
    this.emitTerminal(activeRun, normalizedOutcome);
  }

  private acceptRuntimeFailure(activeRun: ActiveRun, error: unknown): void {
    if (!this.isCurrentRunning(activeRun)) {
      return;
    }

    const outcome: ProviderRunOutcome = {
      status: 'failed',
      providerSessionId: activeRun.providerSessionId,
      exitCode: 1,
      error,
    };
    activeRun.state = 'failed';
    this.emitTerminal(activeRun, outcome);
  }

  private normalizeOutcome(
    activeRun: ActiveRun,
    outcome: ProviderRunOutcome,
  ): ProviderRunOutcome {
    const providerSessionId = activeRun.providerSessionId ?? outcome.providerSessionId;
    switch (outcome.status) {
      case 'completed':
        return { status: 'completed', providerSessionId, exitCode: 0 };
      case 'aborted':
        return {
          status: 'aborted',
          providerSessionId,
          exitCode: outcome.exitCode,
        };
      case 'failed':
        return {
          status: 'failed',
          providerSessionId,
          exitCode: Number.isFinite(outcome.exitCode) && outcome.exitCode !== 0
            ? outcome.exitCode
            : 1,
          errorCode: outcome.errorCode,
          error: outcome.error,
        };
    }
  }

  private emitTerminal(activeRun: ActiveRun, outcome: ProviderRunOutcome): void {
    this.write(activeRun, () => {
      activeRun.writer.send(createCompleteMessage({
        provider: activeRun.request.provider,
        sessionId: activeRun.request.appSessionId,
        actualSessionId: activeRun.request.appSessionId,
        exitCode: outcome.exitCode,
        aborted: outcome.status === 'aborted',
      }));
    });
    activeRun.resolveOutcome(outcome);
  }

  private isCurrentRunning(activeRun: ActiveRun): boolean {
    return (
      activeRun.state === 'running'
      && this.activeRuns.get(activeRun.request.appSessionId) === activeRun
    );
  }

  private bindProviderSession(activeRun: ActiveRun, providerSessionId: string): boolean {
    if (!this.isCurrentRunning(activeRun) || activeRun.providerSessionId !== null) {
      return false;
    }

    // Identity is first-wins. Persist it before exposing it to any transport so
    // a client can immediately resume with the stable app-facing session id.
    if (activeRun.persistsSessionIdentity) {
      try {
        this.dependencies.sessionIdentity?.assignProviderSessionId(
          activeRun.request.appSessionId,
          providerSessionId,
          activeRun.request.provider,
        );
      } catch (error) {
        const outcome: ProviderRunOutcome = {
          status: 'failed',
          providerSessionId: null,
          exitCode: 1,
          error,
        };
        activeRun.state = 'failed';
        activeRun.abortController.abort();
        this.emitTerminal(activeRun, outcome);
        return false;
      }
    }

    activeRun.providerSessionId = providerSessionId;
    this.write(activeRun, () => {
      activeRun.writer.setSessionId?.(providerSessionId);
    });
    return true;
  }

  private write(activeRun: ActiveRun, operation: () => void): void {
    try {
      operation();
    } catch (error) {
      // Terminal ownership is already fixed before terminal output begins.
      // A broken transport cannot reopen the run or cause a second terminal.
      console.error('[ProviderRunCoordinator] Runtime output writer failed', {
        provider: activeRun.request.provider,
        appSessionId: activeRun.request.appSessionId,
        runId: activeRun.runId,
        error,
      });
    }
  }
}
