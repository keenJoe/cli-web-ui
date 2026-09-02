/**
 * Pi runtime - live turn execution over the official RPC client.
 *
 * Responsibilities (see design.md decision 1/2, spec: live chat / 身份绑定 / 中止):
 * - Drive one turn through the state machine
 *   SPAWNING → REQUESTING_STATE → BINDING_SESSION → PROMPTING → STREAMING → SETTLED.
 * - Bind the app/native session (from `get_state`) BEFORE the first live event.
 * - Map native `AgentSessionEvent`s to normalized events via a pure function.
 * - Treat `agent_settled` as the only success terminal; a close before it fails
 *   with `ERR-PI-RUN-FAILED`; an illegal payload on a known event fails with
 *   `ERR-PI-RPC-PROTOCOL`; unknown events are ignored (debug-logged).
 * - Observe the coordinator-owned AbortSignal: send `{type:'abort'}`
 *   (`client.abort()`), wait a bounded grace window for `agent_settled`, then
 *   force-kill and return an aborted outcome. All lifecycle state is run-local,
 *   so cancelling one generation cannot affect another run of the same session.
 */
import { randomUUID } from 'node:crypto';

import type { RpcClientOptions, RpcSessionState } from '@earendil-works/pi-coding-agent';

import type {
  IProviderEventSink,
  IProviderRuntime,
} from '@/shared/interfaces.js';
import type {
  ProviderPermissionDecision,
  ProviderRunEvent,
  ProviderRunOutcome,
  ProviderRunRequest,
  ProviderRuntimeContext,
} from '@/shared/types.js';
import { createNormalizedMessage, AppError } from '@/shared/utils.js';

import { PiRpcClient, type PiRpcClientDeps } from './pi-rpc-client.provider.js';

/** Bounded graceful-abort window before the process is force-killed. */
const DEFAULT_ABORT_GRACE_MS = 5000;
const RUN_CLOSE_GRACE_MS = 1000;
const DEFAULT_THINKING_FLUSH_MS = 100;

/** Runtime states (progress markers; terminal handling is guarded separately). */
export type PiRuntimeState =
  | 'SPAWNING'
  | 'REQUESTING_STATE'
  | 'BINDING_SESSION'
  | 'PROMPTING'
  | 'STREAMING'
  | 'SETTLED';

/**
 * Provider-local event produced by {@link mapPiEvent} and consumed by the Pi
 * runtime. Thinking lifecycle variants stay private to this adapter; the
 * runtime turns them into stable `kind: "thinking"` message snapshots before
 * anything crosses the provider boundary.
 */
export type NormalizedPiEvent =
  | { kind: 'stream_delta'; content: string }
  | { kind: 'thinking_start'; contentIndex: number }
  | { kind: 'thinking_delta'; contentIndex: number; content: string }
  | { kind: 'thinking_end'; contentIndex: number; content: string }
  | { kind: 'tool_use'; toolId: string; toolName: string; toolInput: unknown }
  | { kind: 'tool_result'; toolId: string; toolName: string; content: string; isError: boolean }
  | { kind: 'error'; content: string }
  | { kind: 'status'; status: string };

type ActiveThinkingBlock = {
  id: string;
  contentIndex: number;
  content: string;
  lastSentContent: string;
  startedAtMs: number;
  timestamp: string;
  flushTimer?: NodeJS.Timeout;
};

/** Minimal RPC surface the runtime depends on (satisfied by {@link PiRpcClient}). */
export interface PiRuntimeRpc {
  start(): Promise<void>;
  onEvent(listener: (event: unknown) => void): () => void;
  getState(): Promise<RpcSessionState>;
  prompt(message: string, images?: unknown[]): Promise<void>;
  abort(): Promise<void>;
  close(graceMs: number): Promise<void>;
  getStderr(): string;
  /**
   * Optional notification that the underlying process exited. When present the
   * runtime uses it to detect a close before `agent_settled` (ERR-PI-RUN-FAILED).
   */
  onClose?(listener: () => void): () => void;
  /**
   * Write one raw JSON object to the child's stdin as a strict JSONL line.
   *
   * Backs the extension-UI responder: the official client's `send()` is
   * request/response correlated and cannot send `extension_ui_response`.
   */
  sendRaw(command: unknown): void;
}

/** Factory seam so tests inject a stub RPC client instead of spawning `pi`. */
export type CreatePiRuntimeRpc = (
  options: RpcClientOptions,
  deps?: PiRpcClientDeps,
) => PiRuntimeRpc;

/** Default factory: the real {@link PiRpcClient} (spawns `pi --mode rpc --no-extensions`). */
export const defaultCreatePiRuntimeRpc: CreatePiRuntimeRpc = (options, deps) =>
  new PiRpcClient(options, deps);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolError(message: string): AppError {
  return new AppError(message, { code: 'ERR-PI-RPC-PROTOCOL' });
}

function formatPiToolResultContent(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (isRecord(result)) {
    if (typeof result.content === 'string') {
      return result.content;
    }

    if (Array.isArray(result.content)) {
      const textBlocks = result.content.flatMap((block) =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string'
          ? [block.text]
          : [],
      );
      if (textBlocks.length > 0) {
        return textBlocks.join('\n');
      }
    }
  }

  if (result === undefined) {
    return '';
  }

  try {
    return JSON.stringify(result) ?? '';
  } catch {
    try {
      return String(result);
    } catch {
      return '';
    }
  }
}

/**
 * Pure mapping from a native `AgentSessionEvent` to a normalized event.
 *
 * Returns `null` for events we intentionally ignore (unknown types, lifecycle
 * markers with no UI payload). Throws `ERR-PI-RPC-PROTOCOL` when a KNOWN event
 * carries an illegal payload — never silently treats it as success data.
 * `agent_settled` is a terminal signal, not a normalized event; callers detect
 * it with {@link isSettledEvent} before calling this.
 */
export function mapPiEvent(event: unknown): NormalizedPiEvent | null {
  if (!isRecord(event) || typeof event.type !== 'string') {
    return null;
  }

  switch (event.type) {
    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (!isRecord(inner) || typeof inner.type !== 'string') {
        throw protocolError('message_update missing assistantMessageEvent');
      }
      if (inner.type === 'text_delta') {
        if (typeof inner.delta !== 'string') {
          throw protocolError('text_delta missing string delta');
        }
        return { kind: 'stream_delta', content: inner.delta };
      }
      if (inner.type === 'thinking_start') {
        if (!Number.isInteger(inner.contentIndex) || (inner.contentIndex as number) < 0) {
          throw protocolError('thinking_start missing valid contentIndex');
        }
        return { kind: 'thinking_start', contentIndex: inner.contentIndex as number };
      }
      if (inner.type === 'thinking_delta') {
        if (
          !Number.isInteger(inner.contentIndex)
          || (inner.contentIndex as number) < 0
          || typeof inner.delta !== 'string'
        ) {
          throw protocolError('thinking_delta missing valid contentIndex/string delta');
        }
        return {
          kind: 'thinking_delta',
          contentIndex: inner.contentIndex as number,
          content: inner.delta,
        };
      }
      if (inner.type === 'thinking_end') {
        if (
          !Number.isInteger(inner.contentIndex)
          || (inner.contentIndex as number) < 0
          || typeof inner.content !== 'string'
        ) {
          throw protocolError('thinking_end missing valid contentIndex/string content');
        }
        return {
          kind: 'thinking_end',
          contentIndex: inner.contentIndex as number,
          content: inner.content,
        };
      }
      return null;
    }

    case 'tool_execution_start': {
      if (typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') {
        throw protocolError('tool_execution_start missing toolCallId/toolName');
      }
      return {
        kind: 'tool_use',
        toolId: event.toolCallId,
        toolName: event.toolName,
        toolInput: event.args,
      };
    }

    case 'tool_execution_end': {
      if (typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') {
        throw protocolError('tool_execution_end missing toolCallId/toolName');
      }
      const isError = Boolean(event.isError);
      return {
        kind: 'tool_result',
        toolId: event.toolCallId,
        toolName: event.toolName,
        content: formatPiToolResultContent(event.result),
        isError,
      };
    }

    case 'message_end': {
      // Pi reports upstream failures (400 bad request, 429 rate limit, ...) on
      // the finalized assistant message rather than as a dedicated error event.
      // Without this the turn produces no visible output at all: the model
      // emitted no deltas, and `agent_settled` still arrives once Pi exhausts
      // its retries, so the run would look like a silent no-op.
      const message = event.message;
      if (!isRecord(message) || message.stopReason !== 'error') {
        return null;
      }

      const errorMessage = typeof message.errorMessage === 'string'
        ? message.errorMessage.trim()
        : '';
      return { kind: 'error', content: errorMessage || 'ERR-PI-UPSTREAM' };
    }

    case 'turn_end':
      return { kind: 'status', status: 'turn_end' };

    case 'auto_retry_start': {
      if (typeof event.attempt !== 'number') {
        throw protocolError('auto_retry_start missing attempt');
      }
      return { kind: 'status', status: 'retry' };
    }

    case 'auto_retry_end':
      return { kind: 'status', status: 'retry_end' };

    default:
      // Unknown / unmapped lifecycle events are ignored (debug-logged by caller).
      return null;
  }
}

/** `agent_settled` is the ONLY success terminal event. */
export function isSettledEvent(event: unknown): boolean {
  return isRecord(event) && event.type === 'agent_settled';
}

// ---------------------------------------------------------------------------
// Extension UI dialog protocol
// ---------------------------------------------------------------------------

/** Tool name emitted in `permission_request` events for extension UI dialogs. */
const PI_EXTENSION_UI_TOOL = 'pi-extension-ui';

/** Extension UI methods that block until the client responds. */
const EXTENSION_UI_DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

/**
 * Returns the dialog method when `event` is a blocking `extension_ui_request`
 * (one of `select` / `confirm` / `input` / `editor`), or `null` for fire-
 * and-forget methods (`notify` / `setStatus` / …) and non-extension events.
 */
export function readExtensionUiDialogMethod(
  event: unknown,
): 'select' | 'confirm' | 'input' | 'editor' | null {
  if (!isRecord(event) || event.type !== 'extension_ui_request') return null;
  const method = typeof event.method === 'string' ? event.method : '';
  return (EXTENSION_UI_DIALOG_METHODS.has(method) ? method : null) as never;
}

/**
 * Translates one `chat.permission-response` decision back into the partial
 * `extension_ui_response` payload (without the `type` / `id` envelope).
 *
 * - `confirm`   → `{ confirmed: boolean }`
 * - `select`    → `{ value: string }` or `{ cancelled: true }`
 * - `input`     → `{ value: string }` or `{ cancelled: true }`
 * - `editor`    → `{ value: string }` or `{ cancelled: true }`
 */
export function buildExtensionUiResponse(
  method: 'select' | 'confirm' | 'input' | 'editor',
  decision: ProviderPermissionDecision,
): Record<string, unknown> {
  if (method === 'confirm') {
    return { confirmed: Boolean(decision.allow) };
  }
  if (decision.allow === false) {
    return { cancelled: true };
  }
  const value = typeof decision.updatedInput === 'string'
    ? decision.updatedInput
    : (typeof decision.message === 'string' ? decision.message : '');
  return { value };
}

function buildRpcClientOptions(
  request: ProviderRunRequest,
  nativeSessionId: string | null,
): RpcClientOptions {
  const rpcOptions: RpcClientOptions = {
    cwd: request.cwd,
  };
  const model = request.model?.trim() ?? '';
  const separatorIndex = model.indexOf('/');
  if (separatorIndex > 0 && separatorIndex < model.length - 1) {
    rpcOptions.provider = model.slice(0, separatorIndex);
    rpcOptions.model = model.slice(separatorIndex + 1);
  } else if (model) {
    rpcOptions.model = model;
  }

  const args: string[] = [];
  if (nativeSessionId) {
    args.push('--session-id', nativeSessionId);
  }
  const effort = request.effort?.trim() ?? '';
  if (effort && effort !== 'default') {
    args.push('--thinking', effort);
  }
  if (args.length > 0) {
    rpcOptions.args = args;
  }

  return rpcOptions;
}

export interface PiRuntimeDeps {
  createRpcClient?: CreatePiRuntimeRpc;
  abortGraceMs?: number;
  /** Snapshot throttle for streamed thinking; tests set zero for determinism. */
  thinkingFlushMs?: number;
}

/**
 * One blocked extension-UI dialog awaiting a `chat.permission-response`.
 *
 * Lives at the runtime (not run) scope so `permissions.resolve` can answer it
 * after the originating `run` promise has handed control back to the
 * websocket handler; `respond` closes over that run's RPC child stdin.
 */
type PendingExtensionDialog = {
  requestId: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  runId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  receivedAt: Date;
  respond: (response: Record<string, unknown>) => void;
};

/**
 * Builds the Pi runtime. `deps` supplies the RPC-client factory (a stub in
 * tests) and the abort grace window.
 */
export function createPiRuntime(deps: PiRuntimeDeps = {}): IProviderRuntime {
  const createRpcClient = deps.createRpcClient ?? defaultCreatePiRuntimeRpc;
  const abortGraceMs = deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const thinkingFlushMs = Math.max(0, deps.thinkingFlushMs ?? DEFAULT_THINKING_FLUSH_MS);

  // Shared across runs: extension UI dialogs block their turn and are resolved
  // out-of-band via `permissions.resolve`, which the websocket layer reaches
  // through the provider registry rather than through one run's promise.
  const pendingDialogs = new Map<string, PendingExtensionDialog>();

  const resolveExtensionUiDialog = (
    requestId: string,
    decision: ProviderPermissionDecision,
  ): void => {
    const pending = pendingDialogs.get(requestId);
    if (!pending) return;
    pendingDialogs.delete(requestId);

    const partial = buildExtensionUiResponse(pending.method, decision);
    try {
      pending.respond(partial);
    } catch (error) {
      console.warn('[Pi] failed to respond to extension UI dialog', error);
    }
  };

  const listPendingExtensionUiDialogs = (sessionId: string): unknown[] => {
    const pending: unknown[] = [];
    for (const dialog of pendingDialogs.values()) {
      if (dialog.sessionId === sessionId) {
        pending.push({
          requestId: dialog.requestId,
          toolName: dialog.toolName,
          input: dialog.input,
          sessionId: dialog.sessionId,
          receivedAt: dialog.receivedAt,
        });
      }
    }
    return pending;
  };

  async function run(
    request: ProviderRunRequest,
    sink: IProviderEventSink,
    _context: ProviderRuntimeContext,
    signal: AbortSignal,
  ): Promise<ProviderRunOutcome> {
    const images = request.images ? [...request.images] : undefined;
    const requestedNativeSessionId = request.providerSessionId;

    let state: PiRuntimeState = 'SPAWNING';
    let settled = false;
    let aborting = false;
    let boundSessionId = request.providerSessionId;
    const activeThinkingBlocks = new Map<number, ActiveThinkingBlock>();

    const rpc = createRpcClient(buildRpcClientOptions(request, requestedNativeSessionId));

    return new Promise<ProviderRunOutcome>((resolve) => {
      let abortTimer: NodeJS.Timeout | undefined;
      let unsubscribeEvents: (() => void) | undefined;
      let unsubscribeClose: (() => void) | undefined;

      const createThinkingBlock = (contentIndex: number): ActiveThinkingBlock => {
        const existing = activeThinkingBlocks.get(contentIndex);
        if (existing) {
          return existing;
        }

        const startedAtMs = Date.now();
        const block: ActiveThinkingBlock = {
          id: `thinking_${randomUUID()}`,
          contentIndex,
          content: '',
          lastSentContent: '',
          startedAtMs,
          timestamp: new Date(startedAtMs).toISOString(),
        };
        activeThinkingBlocks.set(contentIndex, block);
        return block;
      };

      const sendThinkingSnapshot = (
        block: ActiveThinkingBlock,
        isStreaming: boolean,
      ): void => {
        if (block.flushTimer) {
          clearTimeout(block.flushTimer);
          block.flushTimer = undefined;
        }
        if (aborting) {
          return;
        }
        if (
          (!block.content && (isStreaming || !block.lastSentContent))
          || (isStreaming && block.content === block.lastSentContent)
        ) {
          return;
        }

        state = 'STREAMING';
        sink.emit(
          createNormalizedMessage({
            id: block.id,
            kind: 'thinking',
            provider: 'pi',
            sessionId: request.appSessionId,
            timestamp: block.timestamp,
            content: block.content,
            isStreaming,
            duration: isStreaming
              ? undefined
              : Math.max(1, Math.ceil((Date.now() - block.startedAtMs) / 1000)),
          }) as ProviderRunEvent,
        );
        block.lastSentContent = block.content;
      };

      const scheduleThinkingSnapshot = (block: ActiveThinkingBlock): void => {
        if (!block.lastSentContent || thinkingFlushMs === 0) {
          sendThinkingSnapshot(block, true);
          return;
        }
        if (!block.flushTimer) {
          block.flushTimer = setTimeout(() => {
            block.flushTimer = undefined;
            sendThinkingSnapshot(block, true);
          }, thinkingFlushMs);
        }
      };

      const finalizeThinkingBlock = (
        contentIndex: number,
        authoritativeContent?: string,
      ): void => {
        const block = activeThinkingBlocks.get(contentIndex);
        if (!block) {
          if (authoritativeContent) {
            const recovered = createThinkingBlock(contentIndex);
            recovered.content = authoritativeContent;
            sendThinkingSnapshot(recovered, false);
            activeThinkingBlocks.delete(contentIndex);
          }
          return;
        }

        if (authoritativeContent !== undefined) {
          block.content = authoritativeContent;
        }
        sendThinkingSnapshot(block, false);
        activeThinkingBlocks.delete(contentIndex);
      };

      const finalizeAllThinkingBlocks = (): void => {
        for (const contentIndex of [...activeThinkingBlocks.keys()]) {
          finalizeThinkingBlock(contentIndex);
        }
      };

      const finish = (
        outcome: ProviderRunOutcome,
        closeGraceMs = RUN_CLOSE_GRACE_MS,
      ): void => {
        if (settled) return;
        settled = true;
        // Any dialogs this run was still blocked on are now unreachable — the
        // child is closing. Cancel them so `permission_cancelled` clears the UI
        // and `listPending` never reports a dead dialog on reconnect.
        for (const [requestId, dialog] of pendingDialogs.entries()) {
          if (dialog.runId === request.runId) {
            pendingDialogs.delete(requestId);
            sink.emit(
              createNormalizedMessage({
                kind: 'permission_cancelled',
                provider: 'pi',
                sessionId: request.appSessionId,
                requestId,
                reason: 'run_finished',
              }) as ProviderRunEvent,
            );
          }
        }
        finalizeAllThinkingBlocks();
        state = 'SETTLED';
        if (abortTimer) clearTimeout(abortTimer);
        signal.removeEventListener('abort', beginAbort);
        unsubscribeEvents?.();
        unsubscribeClose?.();

        if (outcome.status === 'failed') {
          sink.emit(
            createNormalizedMessage({
              kind: 'error',
              provider: 'pi',
              sessionId: request.appSessionId,
              content: outcome.errorCode ?? 'ERR-PI-RUN-FAILED',
              code: outcome.errorCode,
            }) as ProviderRunEvent,
          );
        }
        void rpc.close(closeGraceMs).finally(() => resolve(outcome));
      };

      const beginAbort = (): void => {
        if (settled || aborting) return;
        aborting = true;
        // Send the abort request; wait a bounded window for agent_settled, then
        // force-kill. Either path settles the run as aborted exactly once.
        void rpc.abort().catch(() => undefined);
        abortTimer = setTimeout(() => {
          finish({
            status: 'aborted',
            providerSessionId: boundSessionId,
            exitCode: 1,
          }, 0);
        }, abortGraceMs);
      };

      if (signal.aborted) {
        // Abort before we even start: settle immediately as aborted.
        queueMicrotask(() => finish({
          status: 'aborted',
          providerSessionId: boundSessionId,
          exitCode: 1,
        }));
        return;
      }
      signal.addEventListener('abort', beginAbort, { once: true });

      const beginExtensionUiDialog = (
        method: 'select' | 'confirm' | 'input' | 'editor',
        rawEvent: Record<string, unknown>,
      ): void => {
        const requestId = typeof rawEvent.id === 'string' ? rawEvent.id : '';
        if (!requestId) {
          finish({
            status: 'failed',
            providerSessionId: boundSessionId,
            exitCode: 1,
            errorCode: 'ERR-PI-RPC-PROTOCOL',
          });
          return;
        }

        pendingDialogs.set(requestId, {
          requestId,
          method,
          runId: request.runId,
          sessionId: request.appSessionId,
          toolName: PI_EXTENSION_UI_TOOL,
          input: rawEvent,
          receivedAt: new Date(),
          respond: (partial) => {
            rpc.sendRaw({ type: 'extension_ui_response', id: requestId, ...partial });
          },
        });

        sink.emit(
          createNormalizedMessage({
            kind: 'permission_request',
            provider: 'pi',
            sessionId: request.appSessionId,
            requestId,
            toolName: PI_EXTENSION_UI_TOOL,
            input: rawEvent,
          }) as ProviderRunEvent,
        );
      };

      const handleEvent = (event: unknown): void => {
        // Once a terminal outcome is reached (settled/aborted/failed) any late
        // native event is ignored, so a single run yields exactly one terminal.
        if (settled) return;

        if (isSettledEvent(event)) {
          // A settle that lands during the grace window is the abort taking
          // effect, not a successful turn.
          finish(
            aborting
              ? {
                status: 'aborted',
                providerSessionId: boundSessionId,
                exitCode: 1,
              }
              : {
                status: 'completed',
                providerSessionId: boundSessionId,
                exitCode: 0,
              },
          );
          return;
        }

        if (aborting) {
          return;
        }

        // Blocking extension UI dialogs never reach `mapPiEvent` (they are not
        // streamed content). Relay them as a permission request and park the
        // resolver until the frontend answers over `chat.permission-response`.
        const dialogMethod = readExtensionUiDialogMethod(event);
        if (dialogMethod !== null) {
          beginExtensionUiDialog(dialogMethod, event as Record<string, unknown>);
          return;
        }

        let normalized: NormalizedPiEvent | null;
        try {
          normalized = mapPiEvent(event);
        } catch {
          finish({
            status: 'failed',
            providerSessionId: boundSessionId,
            exitCode: 1,
            errorCode: 'ERR-PI-RPC-PROTOCOL',
          });
          return;
        }

        if (!normalized) {
          const type = isRecord(event) ? event.type : undefined;
          console.debug('[Pi] ignoring unmapped event', type);
          return;
        }

        if (normalized.kind === 'thinking_start') {
          const existing = activeThinkingBlocks.get(normalized.contentIndex);
          if (existing) {
            finalizeThinkingBlock(normalized.contentIndex);
          }
          createThinkingBlock(normalized.contentIndex);
          return;
        }

        if (normalized.kind === 'thinking_delta') {
          const block = createThinkingBlock(normalized.contentIndex);
          block.content += normalized.content;
          scheduleThinkingSnapshot(block);
          return;
        }

        if (normalized.kind === 'thinking_end') {
          finalizeThinkingBlock(normalized.contentIndex, normalized.content);
          return;
        }

        // Native thinking_end should arrive first. This fallback prevents a
        // malformed or provider-specific sequence from leaving the UI active.
        finalizeAllThinkingBlocks();

        state = 'STREAMING';
        sink.emit(
          createNormalizedMessage({
            ...normalized,
            provider: 'pi',
            sessionId: request.appSessionId,
          }) as ProviderRunEvent,
        );
      };

      // Kick off the state machine. Any failure before settle is a run failure.
      void (async () => {
        try {
          await rpc.start();
          if (settled || aborting) return;

          state = 'REQUESTING_STATE';
          const rpcState = await rpc.getState();
          if (settled || aborting) return;

          state = 'BINDING_SESSION';
          if (!bindSession(rpcState)) return;

          unsubscribeEvents = rpc.onEvent(handleEvent);
          if (rpc.onClose) {
            unsubscribeClose = rpc.onClose(() => {
              if (settled || aborting) return;
              // Process exited before agent_settled: never report success.
              finish({
                status: 'failed',
                providerSessionId: boundSessionId,
                exitCode: 1,
                errorCode: 'ERR-PI-RUN-FAILED',
              });
            });
          }

          state = 'PROMPTING';
          await rpc.prompt(request.command, images);
        } catch {
          if (settled || aborting) return;
          // Process closed / start failed before agent_settled.
          finish({
            status: 'failed',
            providerSessionId: boundSessionId,
            exitCode: 1,
            errorCode: 'ERR-PI-RUN-FAILED',
          });
        }
      })();

      function bindSession(rpcState: RpcSessionState): boolean {
        const nativeId = typeof rpcState?.sessionId === 'string' ? rpcState.sessionId : null;
        if (!nativeId) {
          finish({
            status: 'failed',
            providerSessionId: boundSessionId,
            exitCode: 1,
            errorCode: 'ERR-PI-RPC-PROTOCOL',
          });
          return false;
        }

        if (boundSessionId !== null) {
          if (boundSessionId !== nativeId) {
            finish({
              status: 'failed',
              providerSessionId: boundSessionId,
              exitCode: 1,
              errorCode: 'ERR-PI-RPC-PROTOCOL',
            });
            return false;
          }
          return true;
        }

        boundSessionId = nativeId;
        sink.bindProviderSession({
          providerSessionId: nativeId,
          artifactPath: typeof rpcState.sessionFile === 'string'
            ? rpcState.sessionFile
            : undefined,
        });
        return true;
      }
    });
  }

  return {
    run,
    permissions: {
      resolve: resolveExtensionUiDialog,
      listPending: listPendingExtensionUiDialogs,
    },
  };
}

/** Default runtime instance used by the provider registry. */
export const piRuntime = createPiRuntime();
