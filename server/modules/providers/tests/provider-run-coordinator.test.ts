import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderRunCoordinator } from '@/modules/providers/services/provider-run-coordinator.service.js';
import type {
  IProviderRuntime,
  IProviderSessionIdentityStore,
  ProviderDefinition,
} from '@/shared/interfaces.js';
import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel ?? undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createProvider(runtime: IProviderRuntime): ProviderDefinition {
  return {
    id: 'claude',
    descriptor: {
      permissionModes: ['default'],
      defaultPermissionMode: 'default',
      supportsImages: true,
      supportsFiles: true,
      supportsAbort: true,
      supportsPermissionRequests: true,
      supportsEffort: true,
    },
    runtime,
    models: {} as never,
    auth: {} as never,
    sessions: {} as never,
    sessionSynchronizer: {} as never,
  };
}

function createWriter() {
  const events: NormalizedMessage[] = [];
  const bindings: string[] = [];
  const writer: ProviderRuntimeWriter = {
    send(data) {
      events.push(data as NormalizedMessage);
    },
    setSessionId(providerSessionId) {
      bindings.push(providerSessionId);
    },
  };
  return { bindings, events, writer };
}

function createCoordinator(
  runtime: IProviderRuntime,
  createRunId: () => string = () => 'run-1',
  sessionIdentity?: IProviderSessionIdentityStore,
): ProviderRunCoordinator {
  const provider = createProvider(runtime);
  return new ProviderRunCoordinator({
    createRunId,
    sessionIdentity,
    resolveProvider(providerId) {
      if (providerId !== provider.id) {
        throw new AppError(`Unsupported provider: ${providerId}`, {
          code: 'UNSUPPORTED_PROVIDER',
          statusCode: 400,
        });
      }
      return provider;
    },
  });
}

const request = {
  provider: 'claude' as const,
  appSessionId: 'app-session-1',
  providerSessionId: null,
  command: 'hello',
  permissionMode: 'default',
  userId: null,
};

test('R10: coordinator binds identity, forwards events, and emits one success terminal', async () => {
  const runtime: IProviderRuntime = {
    async run(_request, sink) {
      sink.bindProviderSession({ providerSessionId: 'native-session-1' });
      sink.emit({
        id: 'event-1',
        kind: 'text',
        provider: 'claude',
        sessionId: 'native-session-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: 'hello',
      });
      return { status: 'completed', providerSessionId: 'native-session-1', exitCode: 0 };
    },
  };
  const coordinator = createCoordinator(runtime);
  const output = createWriter();

  const outcome = await coordinator.run(request, output.writer, context);

  assert.deepEqual(outcome, {
    status: 'completed',
    providerSessionId: 'native-session-1',
    exitCode: 0,
  });
  assert.deepEqual(output.bindings, ['native-session-1']);
  assert.deepEqual(output.events.map((event) => event.kind), [
    'session_created',
    'text',
    'complete',
  ]);
  assert.equal(output.events[1]?.sessionId, 'app-session-1');
  assert.equal(output.events[2]?.success, true);
});

test('R11: accepted abort wins over late runtime events and outcomes', async () => {
  let releaseRuntime!: () => void;
  const runtimeReleased = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  const runtime: IProviderRuntime = {
    async run(_request, sink, _context, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      sink.emit({
        id: 'late-event',
        kind: 'text',
        provider: 'claude',
        sessionId: 'native-session-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        content: 'late',
      });
      await runtimeReleased;
      return { status: 'completed', providerSessionId: 'native-session-1', exitCode: 0 };
    },
  };
  const coordinator = createCoordinator(runtime);
  const output = createWriter();

  const run = coordinator.run(request, output.writer, context);
  await Promise.resolve();
  assert.equal(coordinator.abort('app-session-1'), true);
  const outcome = await run;
  releaseRuntime();
  await Promise.resolve();

  assert.deepEqual(outcome, {
    status: 'aborted',
    providerSessionId: null,
    exitCode: 1,
  });
  assert.deepEqual(output.events.map((event) => event.kind), ['complete']);
  assert.equal(output.events[0]?.aborted, true);
  assert.equal(coordinator.abort('app-session-1'), false);
});

test('R12: a runtime throw becomes exactly one failed terminal', async () => {
  const runtimeError = new Error('runtime crashed');
  const coordinator = createCoordinator({
    async run() {
      throw runtimeError;
    },
  });
  const output = createWriter();

  const outcome = await coordinator.run(request, output.writer, context);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.error, runtimeError);
  assert.deepEqual(output.events.map((event) => event.kind), ['complete']);
  assert.equal(output.events[0]?.success, false);
});

test('R12: a failed outcome can never emit a successful terminal', async () => {
  const coordinator = createCoordinator({
    async run() {
      return {
        status: 'failed',
        providerSessionId: null,
        exitCode: 0,
        errorCode: 'PROCESS_FAILED',
      };
    },
  });
  const output = createWriter();

  const outcome = await coordinator.run(request, output.writer, context);

  assert.deepEqual(outcome, {
    status: 'failed',
    providerSessionId: null,
    exitCode: 1,
    errorCode: 'PROCESS_FAILED',
    error: undefined,
  });
  assert.equal(output.events.length, 1);
  assert.equal(output.events[0]?.kind, 'complete');
  assert.equal(output.events[0]?.exitCode, 1);
  assert.equal(output.events[0]?.success, false);
});

test('coordinator rejects a second active run for the same app session', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = createCoordinator({
    async run() {
      await blocked;
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
  });
  const firstOutput = createWriter();
  const firstRun = coordinator.run(request, firstOutput.writer, context);

  await assert.rejects(
    () => coordinator.run(request, createWriter().writer, context),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'RUN_IN_PROGRESS'
      && error.statusCode === 409
    ),
  );

  release();
  await firstRun;
});

test('native identity binding is first-wins across sink and outcome races', async () => {
  const coordinator = createCoordinator({
    async run(_request, sink) {
      sink.bindProviderSession({ providerSessionId: 'native-first' });
      sink.bindProviderSession({ providerSessionId: 'native-second' });
      return {
        status: 'completed',
        providerSessionId: 'native-outcome',
        exitCode: 0,
      };
    },
  });
  const output = createWriter();

  const outcome = await coordinator.run(request, output.writer, context);

  assert.deepEqual(outcome, {
    status: 'completed',
    providerSessionId: 'native-first',
    exitCode: 0,
  });
  assert.deepEqual(output.bindings, ['native-first']);
  assert.deepEqual(output.events.map((event) => event.kind), [
    'session_created',
    'complete',
  ]);
});

test('an outcome-only native identity is persisted before the writer observes it', async () => {
  const operations: string[] = [];
  const persistedSessions = new Map<string, string | null>();
  const coordinator = createCoordinator(
    {
      async run() {
        operations.push('runtime');
        return {
          status: 'completed',
          providerSessionId: 'native-outcome-only',
          exitCode: 0,
        };
      },
    },
    () => 'run-outcome-only',
    {
      ensureAppSession(appSessionId) {
        operations.push('ensure');
        persistedSessions.set(appSessionId, null);
      },
      assignProviderSessionId(appSessionId, providerSessionId) {
        operations.push('persist');
        assert.equal(persistedSessions.has(appSessionId), true);
        persistedSessions.set(appSessionId, providerSessionId);
      },
    },
  );
  const output = createWriter();
  output.writer.setSessionId = (providerSessionId) => {
    operations.push('writer');
    output.bindings.push(providerSessionId);
  };

  const outcome = await coordinator.run(
    { ...request, projectPath: '/workspace/project' },
    output.writer,
    context,
  );

  assert.equal(outcome.providerSessionId, 'native-outcome-only');
  assert.equal(persistedSessions.get(request.appSessionId), 'native-outcome-only');
  assert.deepEqual(output.bindings, ['native-outcome-only']);
  assert.deepEqual(operations, ['ensure', 'runtime', 'persist', 'writer']);
});

test('a native identity persistence failure aborts the runtime and emits one failed terminal', async () => {
  let runtimeObservedAbort = false;
  const coordinator = createCoordinator(
    {
      async run(_request, sink, _context, signal) {
        signal.addEventListener('abort', () => {
          runtimeObservedAbort = true;
        }, { once: true });
        sink.bindProviderSession({ providerSessionId: 'native-persist-failure' });
        return {
          status: 'completed',
          providerSessionId: 'native-persist-failure',
          exitCode: 0,
        };
      },
    },
    () => 'run-persist-failure',
    {
      ensureAppSession() {},
      assignProviderSessionId() {
        throw new Error('mapping write failed');
      },
    },
  );
  const output = createWriter();

  const outcome = await coordinator.run(
    { ...request, projectPath: '/workspace/project' },
    output.writer,
    context,
  );

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.providerSessionId, null);
  assert.equal(runtimeObservedAbort, true);
  assert.deepEqual(output.bindings, []);
  assert.deepEqual(output.events.map((event) => event.kind), ['complete']);
  assert.equal(output.events[0]?.success, false);
});

test('a terminal writer failure cannot reopen or duplicate a completed run', async () => {
  const coordinator = createCoordinator({
    async run() {
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
  });
  let sendCalls = 0;
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const outcome = await coordinator.run(
      request,
      {
        send() {
          sendCalls += 1;
          throw new Error('transport closed');
        },
      },
      context,
    );

    assert.equal(outcome.status, 'completed');
    assert.equal(sendCalls, 1);
    assert.equal(coordinator.abort(request.appSessionId), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('late work from an aborted generation cannot affect the next generation', async () => {
  let firstSink: Parameters<IProviderRuntime['run']>[1] | undefined;
  let rejectFirst!: (error: Error) => void;
  let secondSink: Parameters<IProviderRuntime['run']>[1] | undefined;
  let resolveSecond!: () => void;
  const runtime: IProviderRuntime = {
    run(receivedRequest, sink) {
      if (receivedRequest.runId === 'run-old') {
        firstSink = sink;
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }

      secondSink = sink;
      return new Promise((resolve) => {
        resolveSecond = () => resolve({
          status: 'completed',
          providerSessionId: 'native-new',
          exitCode: 0,
        });
      });
    },
  };
  const runIds = ['run-old', 'run-new'];
  const coordinator = createCoordinator(runtime, () => runIds.shift() as string);
  const oldOutput = createWriter();
  const newOutput = createWriter();

  const oldRun = coordinator.run(request, oldOutput.writer, context);
  await Promise.resolve();
  assert.equal(coordinator.abort(request.appSessionId), true);
  assert.equal((await oldRun).status, 'aborted');

  const newRun = coordinator.run(request, newOutput.writer, context);
  await Promise.resolve();
  firstSink?.emit({
    id: 'late-old-event',
    kind: 'text',
    provider: 'claude',
    sessionId: request.appSessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    content: 'late old output',
  });
  rejectFirst(new Error('late old rejection'));
  secondSink?.emit({
    id: 'new-event',
    kind: 'text',
    provider: 'claude',
    sessionId: request.appSessionId,
    timestamp: '2026-01-01T00:00:01.000Z',
    content: 'new output',
  });
  resolveSecond();

  assert.equal((await newRun).status, 'completed');
  assert.deepEqual(oldOutput.events.map((event) => event.kind), ['complete']);
  assert.deepEqual(newOutput.events.map((event) => event.kind), ['text', 'complete']);
  assert.equal(newOutput.events.some((event) => event.content === 'late old output'), false);
});
