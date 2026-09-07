import assert from 'node:assert/strict';
import test from 'node:test';

import type { RpcClientOptions } from '@earendil-works/pi-coding-agent';

import type { IProviderEventSink, IProviderRuntime } from '@/shared/interfaces.js';
import type {
  ProviderRunRequest,
  ProviderRuntimeContext,
} from '@/shared/types.js';

import {
  createPiRuntime,
  readVisionBridgeStatus,
  type PiRuntimeRpc,
} from '../pi-runtime.provider.js';

// The real status key constant is not exported; mirror the contract value here
// so the test can assert against the exact namespaced key.
const STATUS_KEY = 'cloudcli.vision-bridge.v1';
const HEALTH_COMMAND = 'cloudcli-vision-bridge-health-v1';

/** Minimal stub RPC that lets a test drive bridge-only behavior. */
class BridgeFakeRpc implements PiRuntimeRpc {
  startCalls = 0;
  getStateCalls = 0;
  getCommandsCalls = 0;
  promptCalls: string[] = [];
  closeCalls: number[] = [];
  commands: Array<{ name: string; source?: string }> = [
    { name: HEALTH_COMMAND, source: 'extension' },
  ];
  getCommandsError: Error | null = null;
  startError: Error | null = null;
  getStateError: Error | null = null;
  promptError: Error | null = null;
  state: { sessionId?: string; sessionFile?: string; isStreaming: boolean } = {
    sessionId: 'native-bridge',
    isStreaming: false,
  };
  capturedOptions: RpcClientOptions | null = null;

  private eventListeners = new Set<(e: unknown) => void>();
  private closeListeners = new Set<() => void>();

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
  }
  onEvent(listener: (e: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  async getState() {
    this.getStateCalls += 1;
    if (this.getStateError) throw this.getStateError;
    return this.state as never;
  }
  async getCommands() {
    this.getCommandsCalls += 1;
    if (this.getCommandsError) throw this.getCommandsError;
    return this.commands;
  }
  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
    if (this.promptError) throw this.promptError;
  }
  async abort(): Promise<void> {}
  async close(graceMs: number): Promise<void> {
    this.closeCalls.push(graceMs);
  }
  sendRaw(_command: unknown): void {}
  getStderr(): string {
    return '';
  }
  emit(event: unknown): void {
    for (const l of [...this.eventListeners]) l(event);
  }
}

interface TestRequestOverrides {
  runId?: string;
  appSessionId?: string;
  clientMessageId?: string;
  userId?: string | number | null;
  images?: ProviderRunRequest['images'];
}

function makeRequest(overrides: TestRequestOverrides = {}): ProviderRunRequest {
  return {
    runId: overrides.runId ?? 'run-bridge',
    provider: 'pi',
    appSessionId: overrides.appSessionId ?? 'app-bridge',
    providerSessionId: null,
    command: 'look at this',
    userId: overrides.userId ?? 'user-1',
    ...(overrides.clientMessageId ? { clientMessageId: overrides.clientMessageId } : {}),
    ...(overrides.images ? { images: overrides.images } : {}),
  };
}

function makeSink() {
  const sent: Array<Record<string, unknown>> = [];
  const bindings: Array<{ providerSessionId: string }> = [];
  const sink: IProviderEventSink = {
    emit(event) {
      sent.push(event as Record<string, unknown>);
    },
    bindProviderSession(binding) {
      bindings.push(binding);
    },
  };
  return { sink, sent, bindings };
}

function makeContext(): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({}) as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A valid started event payload (schema-1) for the namespaced status key. */
function startedEvent(observationId = 'obs-1'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    batchId: 'batch-1',
    observationId,
    phase: 'started',
    source: { kind: 'user', clientMessageId: 'child-claims-client-id' },
    runId: 'child-claims-run',
    appSessionId: 'child-claims-session',
    imageIndex: 1,
    contentHash: 'a'.repeat(64),
    cached: false,
  };
}

// ---------------------------------------------------------------------------
// 5.5: setStatus -> vision_bridge ProviderRunEvent
// ---------------------------------------------------------------------------

test('readVisionBridgeStatus detects only the namespaced setStatus event', () => {
  assert.deepEqual(
    readVisionBridgeStatus({
      type: 'extension_ui_request',
      id: 'u-1',
      method: 'setStatus',
      statusKey: STATUS_KEY,
      statusText: '{"a":1}',
    }),
    { key: STATUS_KEY, text: '{"a":1}' },
  );
  assert.equal(readVisionBridgeStatus({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'nope', statusText: 'x' }), null);
  assert.equal(readVisionBridgeStatus({ type: 'extension_ui_request', method: 'notify' }), null);
  assert.equal(readVisionBridgeStatus({ type: 'message_update' }), null);
});

test('a namespaced setStatus maps to a vision_bridge event with trusted identity override', async () => {
  const fake = new BridgeFakeRpc();
  const runtime = createPiRuntime({
    createRpcClient: (options) => {
      fake.capturedOptions = options;
      return fake;
    },
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink, sent } = makeSink();

  const runPromise = runtime.run(
    makeRequest({ clientMessageId: 'trusted-client-id' }),
    sink,
    makeContext(),
    new AbortController().signal,
  );
  await tick();

  fake.emit({
    type: 'extension_ui_request',
    id: 'u-1',
    method: 'setStatus',
    statusKey: STATUS_KEY,
    statusText: JSON.stringify(startedEvent()),
  });

  const visionEvents = sent.filter((m) => m.kind === 'vision_bridge');
  assert.equal(visionEvents.length, 1);
  const event = visionEvents[0];
  // Child-claimed identity is overwritten with the trusted request values.
  const structural = event.event as Record<string, unknown>;
  assert.equal(structural.runId, 'run-bridge');
  assert.equal(structural.appSessionId, 'app-bridge');
  assert.equal(event.sessionId, 'app-bridge');
  // clientMessageId from the (user) source is surfaced, not the child's run id.
  assert.equal(event.clientMessageId, 'child-claims-client-id');

  // Settle the run.
  fake.emit({ type: 'agent_settled' });
  await runPromise;
});

test('an oversized (>16KiB) status is ignored and does not fail the run', async () => {
  const fake = new BridgeFakeRpc();
  const runtime = createPiRuntime({
    createRpcClient: () => fake,
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink, sent } = makeSink();

  const runPromise = runtime.run(makeRequest(), sink, makeContext(), new AbortController().signal);
  await tick();

  fake.emit({
    type: 'extension_ui_request',
    id: 'u-1',
    method: 'setStatus',
    statusKey: STATUS_KEY,
    statusText: 'x'.repeat(17 * 1024),
  });

  assert.equal(sent.filter((m) => m.kind === 'vision_bridge').length, 0);

  fake.emit({ type: 'agent_settled' });
  const outcome = await runPromise;
  // The run itself still completes normally.
  assert.equal(outcome.status, 'completed');
});

test('a malformed status is ignored without a Pi protocol failure', async () => {
  const fake = new BridgeFakeRpc();
  const runtime = createPiRuntime({
    createRpcClient: () => fake,
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink, sent } = makeSink();

  const runPromise = runtime.run(makeRequest(), sink, makeContext(), new AbortController().signal);
  await tick();

  fake.emit({
    type: 'extension_ui_request',
    id: 'u-1',
    method: 'setStatus',
    statusKey: STATUS_KEY,
    statusText: 'not-json',
  });

  assert.equal(sent.filter((m) => m.kind === 'vision_bridge').length, 0);

  fake.emit({ type: 'agent_settled' });
  assert.equal((await runPromise).status, 'completed');
});

// ---------------------------------------------------------------------------
// 5.2/5.4: live-only bridge injection, probe isolation
// ---------------------------------------------------------------------------

test('live runtime injects -e and bridge env when policy is enabled', async () => {
  const fake = new BridgeFakeRpc();
  const runtime = createPiRuntime({
    createRpcClient: (options) => {
      fake.capturedOptions = options;
      return fake;
    },
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/user-config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink } = makeSink();

  const runPromise = runtime.run(
    makeRequest({ clientMessageId: 'msg-1' }),
    sink,
    makeContext(),
    new AbortController().signal,
  );
  await tick();

  const args = (fake.capturedOptions?.args as string[]) ?? [];
  assert.deepEqual(args, ['-e', '/abs/cloudcli-vision-bridge.ts']);

  const env = (fake.capturedOptions?.env ?? {}) as Record<string, string>;
  assert.equal(env.CLOUDCLI_VISION_BRIDGE_CONFIG_PATH, '/tmp/user-config.json');
  const correlation = JSON.parse(env.CLOUDCLI_VISION_BRIDGE_CORRELATION) as {
    runId: string;
    appSessionId: string;
    clientMessageId?: string;
    contentHashes: string[];
  };
  assert.equal(correlation.runId, 'run-bridge');
  assert.equal(correlation.appSessionId, 'app-bridge');
  assert.equal(correlation.clientMessageId, 'msg-1');
  assert.deepEqual(correlation.contentHashes, []);

  fake.emit({ type: 'agent_settled' });
  await runPromise;
});

test('live runtime injects no bridge when the policy is disabled', async () => {
  const fake = new BridgeFakeRpc();
  const runtime = createPiRuntime({
    createRpcClient: (options) => {
      fake.capturedOptions = options;
      return fake;
    },
    resolveLaunchPolicy: async () => ({ enabled: false, configPath: null }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink } = makeSink();

  const runPromise = runtime.run(makeRequest(), sink, makeContext(), new AbortController().signal);
  await tick();

  assert.deepEqual(fake.capturedOptions?.args ?? [], []);
  assert.equal(fake.capturedOptions?.env, undefined);

  fake.emit({ type: 'agent_settled' });
  await runPromise;
});

test('image payloads are converted by the trusted reader before prompt', async () => {
  const fake = new BridgeFakeRpc();
  const readImages = async () => ({
    images: [{ type: 'image' as const, data: 'QUJD', mimeType: 'image/png' }],
    failures: [],
  });
  const runtime = createPiRuntime({
    createRpcClient: () => fake,
    resolveLaunchPolicy: async () => ({ enabled: false, configPath: null }),
    readImages,
  });
  const { sink } = makeSink();

  const runPromise = runtime.run(
    makeRequest({ images: [{ path: '/store/a.png' }] }),
    sink,
    makeContext(),
    new AbortController().signal,
  );
  await tick();

  // The trusted reader result is passed to prompt, not the raw descriptor.
  assert.deepEqual(fake.promptCalls, ['look at this']);
  assert.equal(fake.state.sessionId, 'native-bridge');

  fake.emit({ type: 'agent_settled' });
  await runPromise;
});

// ---------------------------------------------------------------------------
// 5.6: one-shot no-bridge retry + startup order
// ---------------------------------------------------------------------------

test('a missing health command before binding retries once without the bridge, then succeeds', async () => {
  const attempts: Array<{ options: RpcClientOptions | null }> = [];
  const first = new BridgeFakeRpc();
  first.commands = [{ name: '/help', source: 'prompt' }]; // health command absent
  const second = new BridgeFakeRpc();
  second.commands = [{ name: HEALTH_COMMAND, source: 'extension' }];

  const runtimes = [first, second];
  const runtime = createPiRuntime({
    createRpcClient: (options) => {
      attempts.push({ options });
      const next = runtimes.shift();
      assert.ok(next);
      if (attempts.length === 1) next.capturedOptions = options;
      return next;
    },
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink, sent, bindings } = makeSink();

  const runPromise = runtime.run(makeRequest(), sink, makeContext(), new AbortController().signal);
  await tick();

  // First attempt: bridge injected but health command missing -> no bind, no prompt.
  assert.equal(first.getCommandsCalls, 1);
  assert.equal(first.promptCalls.length, 0);

  // Second attempt: no bridge, health present -> binds and prompts.
  assert.ok(second.startCalls >= 1);
  assert.deepEqual(second.promptCalls, ['look at this']);
  // The diagnostic was emitted before the successful run settled.
  assert.equal(sent.some((m) => m.kind === 'status' && m.code === 'ERR-VB-EXTENSION-START'), true);

  second.emit({ type: 'agent_settled' });
  const outcome = await runPromise;
  assert.equal(outcome.status, 'completed');
  // Native session was bound only on the successful (retry) attempt.
  assert.equal(bindings.length, 1);
});

test('prompt-time error does not retry (prompt may be accepted)', async () => {
  const fake = new BridgeFakeRpc();
  fake.promptError = new Error('prompt failed after send');
  const runtime = createPiRuntime({
    createRpcClient: () => fake,
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink, sent } = makeSink();

  const runPromise = runtime.run(makeRequest(), sink, makeContext(), new AbortController().signal);
  await tick();
  await tick();

  const outcome = await runPromise;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'ERR-PI-RUN-FAILED');
  // No diagnostic, no retry.
  assert.equal(sent.some((m) => m.kind === 'status' && m.code === 'ERR-VB-EXTENSION-START'), false);
  assert.equal(fake.startCalls, 1);
});

test('second bridge hard failure does not retry again', async () => {
  const attempts: number[] = [];
  const runtime = createPiRuntime({
    createRpcClient: (options) => {
      const fake = new BridgeFakeRpc();
      fake.commands = []; // health command absent on every attempt
      fake.capturedOptions = options;
      attempts.push(1);
      // The second (no-bridge) attempt must NOT retry again; simulate the
      // child closing before agent_settled so the run fails with the existing
      // ERR-PI-RUN-FAILED semantics rather than hanging forever.
      if (attempts.length === 2) {
        const closeListeners = new Set<() => void>();
        const originalOnClose = fake.onClose.bind(fake);
        fake.onClose = (listener: () => void): (() => void) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        };
        const originalPrompt = fake.prompt.bind(fake);
        fake.prompt = async (message: string) => {
          await originalPrompt(message);
          // Fire close on next tick so the runtime observes a pre-settle exit.
          queueMicrotask(() => {
            for (const l of [...closeListeners]) l();
          });
        };
      }
      return fake;
    },
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink } = makeSink();

  const runPromise = runtime.run(makeRequest(), sink, makeContext(), new AbortController().signal);
  await tick();
  await tick();
  await tick();
  await tick();

  assert.equal(attempts.length, 2, 'exactly one retry (two total attempts)');
  const outcome = await runPromise;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'ERR-PI-RUN-FAILED');
});

// ---------------------------------------------------------------------------
// 5.8: cancellation -> no late vision_bridge event
// ---------------------------------------------------------------------------

test('late vision_bridge event after abort is dropped', async () => {
  const fake = new BridgeFakeRpc();
  const runtime = createPiRuntime({
    createRpcClient: () => fake,
    abortGraceMs: 5000,
    resolveLaunchPolicy: async () => ({ enabled: true, configPath: '/tmp/config.json' }),
    resolveExtensionPath: () => '/abs/cloudcli-vision-bridge.ts',
    readImages: async () => ({ images: [], failures: [] }),
  });
  const { sink, sent } = makeSink();
  const controller = new AbortController();

  const runPromise = runtime.run(makeRequest(), sink, makeContext(), controller.signal);
  await tick();

  controller.abort();
  fake.emit({ type: 'agent_settled' });
  await runPromise;

  fake.emit({
    type: 'extension_ui_request',
    id: 'u-late',
    method: 'setStatus',
    statusKey: STATUS_KEY,
    statusText: JSON.stringify(startedEvent()),
  });
  await tick();

  assert.equal(sent.filter((m) => m.kind === 'vision_bridge').length, 0);
});