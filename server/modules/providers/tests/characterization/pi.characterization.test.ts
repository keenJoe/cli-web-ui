/**
 * Pi characterization baseline (task 1.1 / R15).
 *
 * Pi is the only provider whose runtime is TypeScript with a first-class
 * dependency-injection seam, so all six scenarios are recorded end-to-end:
 * - `createPiRuntime({ createRpcClient })` — the injected RPC client stands in
 *   for the `pi` subprocess, so live/resume/abort/replay run without spawning.
 * - `PiSessionsProvider.fetchHistory` against a temp session file, selected via
 *   `PI_CODING_AGENT_SESSION_DIR`.
 * - `createProviderTokenUsageService(deps)` for the usage snapshot.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RpcClientOptions } from '@earendil-works/pi-coding-agent';

import { PiPaths } from '@/modules/providers/list/pi/pi-paths.provider.js';
import { PiSessionsProvider } from '@/modules/providers/list/pi/pi-sessions.provider.js';
import { createPiRuntime, type PiRuntimeRpc } from '@/modules/providers/list/pi/pi-runtime.provider.js';
import { ProviderRunCoordinator } from '@/modules/providers/services/provider-run-coordinator.service.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import type {
  IProviderRuntime,
  ProviderDefinition,
} from '@/shared/interfaces.js';
import type {
  ProviderRunOutcome,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

import {
  assertGolden,
  createRecordingWriter,
  createRuntimeContextDouble,
  toEventSpine,
} from './characterization.harness.js';

const SESSION_ID = 'app-session-pi';
const NATIVE_SESSION_ID = 'native-pi-1';

/** Stub RPC client that replays a fixed native Pi event timeline. */
class StubPiRpc implements PiRuntimeRpc {
  state = { sessionId: NATIVE_SESSION_ID, isStreaming: false };

  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();

  abortCalls = 0;
  closeCalls: number[] = [];
  sentRaw: unknown[] = [];

  async start(): Promise<void> {}

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async getState() {
    return this.state as never;
  }

  async prompt(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  async close(graceMs: number): Promise<void> {
    this.closeCalls.push(graceMs);
  }

  sendRaw(command: unknown): void {
    this.sentRaw.push(command);
  }

  getStderr(): string {
    return '';
  }

  emit(event: unknown): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  emitClose(): void {
    for (const listener of [...this.closeListeners]) listener();
  }
}

/** One assistant turn as the Pi RPC agent emits it. */
const LIVE_NATIVE_EVENTS = [
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Plan the read.' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Plan the read.' } },
  { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: { path: 'README.md' } },
  { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'read', result: '# Title', isError: false },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Here is what I found.' } },
  { type: 'turn_end', turnIndex: 0 },
  { type: 'agent_settled' },
];

const tick = () => new Promise((resolve) => setImmediate(resolve));

type PiRunOptions = {
  cwd?: string;
  model?: string;
  effort?: string;
  providerSessionId?: string | null;
};

function createPiCoordinator(runtime: IProviderRuntime): ProviderRunCoordinator {
  const provider: ProviderDefinition = {
    id: 'pi',
    descriptor: {
      permissionModes: ['plan', 'bypassPermissions'],
      defaultPermissionMode: 'bypassPermissions',
      supportsImages: true,
      supportsFiles: true,
      supportsAbort: true,
      supportsPermissionRequests: false,
      supportsEffort: true,
    },
    runtime,
    models: {} as never,
    auth: {} as never,
    sessions: {} as never,
    sessionSynchronizer: {} as never,
  };

  return new ProviderRunCoordinator({
    createRunId: () => 'pi-characterization-run',
    resolveProvider: () => provider,
  });
}

function startPiRun(
  runtime: IProviderRuntime,
  command: string,
  options: PiRunOptions,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const providerSessionId = options.providerSessionId !== undefined
    ? options.providerSessionId
    : context.resolveProviderSessionId(SESSION_ID);
  const coordinator = createPiCoordinator(runtime);
  const run = coordinator.run({
    provider: 'pi',
    appSessionId: SESSION_ID,
    providerSessionId,
    command,
    cwd: options.cwd,
    model: options.model,
    effort: options.effort,
    permissionMode: 'bypassPermissions',
    userId: writer.userId ?? null,
  }, writer, context);

  return { coordinator, run };
}

function toLegacyPiOutcome(outcome: ProviderRunOutcome) {
  switch (outcome.status) {
    case 'completed':
      return { status: 'settled', sessionId: outcome.providerSessionId };
    case 'aborted':
      return { status: 'aborted', sessionId: outcome.providerSessionId };
    case 'failed':
      return {
        status: 'failed',
        sessionId: outcome.providerSessionId,
        errorCode: outcome.errorCode,
      };
  }
}

function toLegacyPiEvents(events: unknown[]): unknown[] {
  return events.map((event) => {
    if (!event || typeof event !== 'object') {
      return event;
    }

    const projected = { ...event as Record<string, unknown> };
    if (projected.provider === 'pi') {
      projected.sessionId = NATIVE_SESSION_ID;
    }
    if (projected.kind === 'complete') {
      projected.actualSessionId = NATIVE_SESSION_ID;
    }
    if (projected.kind === 'session_created' && projected.artifactPath === null) {
      delete projected.artifactPath;
    }
    return projected;
  });
}

function sessionHeader(): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: '00000000-0000-4000-8000-000000000000',
    timestamp: '2026-01-02T03:04:00.000Z',
    cwd: '/repo',
  });
}

/** Writes a Pi session file mirroring the live turn above. */
async function writePiSessionFile(sessionDirectory: string): Promise<string> {
  const filePath = path.join(sessionDirectory, `${NATIVE_SESSION_ID}.jsonl`);
  await writeFile(filePath, [
    sessionHeader(),
    JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-01-02T03:04:00.000Z',
      message: { role: 'user', content: 'Show me the README', timestamp: '2026-01-02T03:04:00.000Z' },
    }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-01-02T03:04:05.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Plan the read.' },
          { type: 'text', text: 'Here is what I found.' },
        ],
        model: 'model-a',
        provider: 'anthropic',
        stopReason: 'stop',
        timestamp: '2026-01-02T03:04:05.000Z',
        usage: {
          input: 120,
          output: 64,
          cacheRead: 40,
          cacheWrite: 8,
          totalTokens: 232,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    }),
  ].join('\n') + '\n', 'utf8');

  return filePath;
}

/**
 * Pi resolves session roots from `PI_CODING_AGENT_SESSION_DIR`, so a temp dir
 * keeps history and usage reads away from real sessions.
 */
async function withTemporarySessionDirectory<T>(
  run: (sessionDirectory: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'characterization-pi-'));
  const sessionDirectory = path.join(root, NATIVE_SESSION_ID);
  await mkdir(sessionDirectory, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDirectory;

  try {
    return await run(sessionDirectory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('pi characterization: live event normalization', async () => {
  const rpc = new StubPiRpc();
  const runtime = createPiRuntime({ createRpcClient: () => rpc, thinkingFlushMs: 0 });
  const { events, boundSessionIds, writer } = createRecordingWriter();

  const { run } = startPiRun(
    runtime,
    'Show me the README',
    {},
    writer,
    createRuntimeContextDouble(),
  );
  await tick();
  for (const event of LIVE_NATIVE_EVENTS) rpc.emit(event);
  const outcome = await run;

  assertGolden('pi.live', {
    outcome: toLegacyPiOutcome(outcome),
    events: toLegacyPiEvents(events),
    boundSessionIds,
  });
});

test('pi characterization: resume forwards the native session id', async () => {
  const rpc = new StubPiRpc();
  let capturedOptions: RpcClientOptions | undefined;
  const runtime = createPiRuntime({
    createRpcClient: (options) => {
      capturedOptions = options;
      return rpc;
    },
  });
  const { events, writer } = createRecordingWriter();

  const { run } = startPiRun(
    runtime,
    'And the CHANGELOG?',
    { cwd: '/repo', model: 'anthropic/model-a' },
    writer,
    createRuntimeContextDouble({ resolveProviderSessionId: () => NATIVE_SESSION_ID }),
  );
  await tick();
  rpc.emit({ type: 'agent_settled' });
  await run;

  assertGolden('pi.resume', {
    rpcOptions: capturedOptions,
    // A resumed run must not re-announce the session to the client.
    sessionCreatedEvents: events.filter(
      (event) => (event as { kind?: string }).kind === 'session_created',
    ).length,
  });
});

test('pi characterization: abort terminal', async () => {
  const rpc = new StubPiRpc();
  const runtime = createPiRuntime({ createRpcClient: () => rpc, abortGraceMs: 5_000 });
  const { events, writer } = createRecordingWriter();

  const { coordinator, run } = startPiRun(
    runtime,
    'Show me the README',
    {},
    writer,
    createRuntimeContextDouble({ resolveProviderSessionId: () => NATIVE_SESSION_ID }),
  );
  await tick();
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
  assert.equal(coordinator.abort(SESSION_ID), true);
  await tick();
  rpc.emit({ type: 'agent_settled' });
  const outcome = await run;

  assertGolden('pi.abort', {
    outcome: toLegacyPiOutcome(outcome),
    abortCalls: rpc.abortCalls,
    events: toLegacyPiEvents(events),
  });
});

test('pi characterization: runtime failure terminal', async () => {
  const rpc = new StubPiRpc();
  const runtime = createPiRuntime({ createRpcClient: () => rpc });
  const { events, boundSessionIds, writer } = createRecordingWriter();

  const { run } = startPiRun(
    runtime,
    'Show me the README',
    {},
    writer,
    createRuntimeContextDouble(),
  );
  await tick();
  // The pi process exits before `agent_settled`: never report success.
  rpc.emitClose();
  const outcome = await run;

  assertGolden('pi.runtime-failure-terminal', {
    outcome: toLegacyPiOutcome(outcome),
    events: toLegacyPiEvents(events),
    boundSessionIds,
  });
});

test('pi characterization: replay suppresses post-terminal native events', async () => {
  const rpc = new StubPiRpc();
  const runtime = createPiRuntime({ createRpcClient: () => rpc, thinkingFlushMs: 0 });
  const { events, writer } = createRecordingWriter();

  const { run } = startPiRun(
    runtime,
    'Show me the README',
    {},
    writer,
    createRuntimeContextDouble(),
  );
  await tick();
  for (const event of LIVE_NATIVE_EVENTS) rpc.emit(event);
  await run;
  const eventCountAtTerminal = events.length;

  // Pi keeps emitting after the terminal; nothing may reach the client.
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } });
  rpc.emit({ type: 'agent_settled' });
  await tick();

  await withTemporarySessionDirectory(async (sessionDirectory) => {
    await writePiSessionFile(sessionDirectory);
    const history = await new PiSessionsProvider(new PiPaths()).fetchHistory(SESSION_ID, {
      providerSessionId: NATIVE_SESSION_ID,
    });

    assertGolden('pi.replay', {
      eventsAfterTerminal: events.length - eventCountAtTerminal,
      completeEvents: events.filter((event) => (event as { kind?: string }).kind === 'complete').length,
      history: toEventSpine(history.messages),
    });
  });
});

test('pi characterization: history normalization', async () => {
  await withTemporarySessionDirectory(async (sessionDirectory) => {
    await writePiSessionFile(sessionDirectory);

    const history = await new PiSessionsProvider(new PiPaths()).fetchHistory(SESSION_ID, {
      providerSessionId: NATIVE_SESSION_ID,
    });

    assertGolden('pi.history', history);
  });
});

test('pi characterization: token usage snapshot', async () => {
  await withTemporarySessionDirectory(async (sessionDirectory) => {
    const sessionFilePath = await writePiSessionFile(sessionDirectory);

    const service = createProviderTokenUsageService({
      getSessionById: () => ({
        session_id: SESSION_ID,
        provider: 'pi',
        provider_session_id: NATIVE_SESSION_ID,
        jsonl_path: sessionFilePath,
        project_path: null,
      }) as never,
    });

    assertGolden('pi.usage', await service.getSessionTokenUsage(SESSION_ID));
  });
});

test('pi characterization: abort of an unknown session', async () => {
  const runtime = createPiRuntime({ createRpcClient: () => new StubPiRpc() });
  const coordinator = createPiCoordinator(runtime);
  assert.equal(coordinator.abort('session-that-never-ran'), false);
});
