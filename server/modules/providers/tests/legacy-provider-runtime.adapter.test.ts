import assert from 'node:assert/strict';
import test from 'node:test';

import { LegacyProviderRuntimeAdapter } from '@/modules/providers/adapters/legacy-provider-runtime.adapter.js';
import { ProviderRunCoordinator } from '@/modules/providers/services/provider-run-coordinator.service.js';
import type {
  IProviderEventSink,
  ProviderDefinition,
} from '@/shared/interfaces.js';
import type {
  ProviderRunEvent,
  ProviderRunRequest,
  ProviderRuntimeContext,
} from '@/shared/types.js';

const request: ProviderRunRequest = {
  runId: 'run-1',
  provider: 'claude',
  appSessionId: 'app-session-1',
  providerSessionId: null,
  command: 'hello',
  cwd: '/workspace',
  projectPath: '/workspace',
  artifactPath: '/workspace/transcript.jsonl',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'acceptEdits',
  sessionSummary: 'Adapter contract',
  images: [{ path: '/workspace/image.png', mimeType: 'image/png' }],
  files: [{ path: '/workspace/notes.txt', mimeType: 'text/plain' }],
  attachments: [{ path: '/workspace/notes.txt', mimeType: 'text/plain' }],
  toolsSettings: {
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
    allowedShellCommands: ['git status'],
    skipPermissions: false,
  },
  skipPermissions: false,
  userId: 'user-1',
};

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel ?? undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createSink() {
  const bindings: Array<{ providerSessionId: string; artifactPath?: string | null }> = [];
  const events: ProviderRunEvent[] = [];
  const sink: IProviderEventSink = {
    bindProviderSession(binding) {
      bindings.push(binding);
    },
    emit(event) {
      events.push(event);
    },
  };
  return { bindings, events, sink };
}

test('R13: adapter maps legacy IO and intercepts every legacy terminal event', async () => {
  const calls: unknown[][] = [];
  const adapter = new LegacyProviderRuntimeAdapter({
    async run(command, options, writer, receivedContext) {
      calls.push([command, options, writer, receivedContext]);
      writer.setSessionId?.('native-session-1');
      writer.send({
        kind: 'session_created',
        provider: 'claude',
        sessionId: 'native-session-1',
        newSessionId: 'native-session-1',
        artifactPath: '/workspace/native.jsonl',
      });
      writer.send({
        id: 'event-1',
        kind: 'text',
        provider: 'claude',
        sessionId: 'native-session-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: 'hello',
      });
      writer.send({
        kind: 'complete',
        provider: 'claude',
        sessionId: 'native-session-1',
        exitCode: 0,
        success: true,
      });
      writer.send({
        kind: 'complete',
        provider: 'claude',
        sessionId: 'native-session-1',
        exitCode: 1,
        success: false,
      });
    },
    abort() {
      return false;
    },
  });
  const output = createSink();
  const controller = new AbortController();

  const outcome = await adapter.run(request, output.sink, context, controller.signal);

  assert.deepEqual(outcome, {
    status: 'completed',
    providerSessionId: 'native-session-1',
    exitCode: 0,
  });
  assert.deepEqual(output.bindings, [{
    providerSessionId: 'native-session-1',
    artifactPath: undefined,
  }]);
  assert.deepEqual(output.events.map((event) => event.kind), ['text']);
  assert.equal(output.events[0]?.sessionId, 'app-session-1');

  const [command, options, writer, receivedContext] = calls[0] as [
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    ProviderRuntimeContext,
  ];
  assert.equal(command, request.command);
  assert.equal(options.sessionId, request.appSessionId);
  assert.equal(options.providerSessionId, request.providerSessionId);
  assert.equal(options.runId, request.runId);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.permissionMode, request.permissionMode);
  assert.equal(options.toolsSettings, request.toolsSettings);
  assert.notEqual(receivedContext, context);
  assert.equal(receivedContext.resolveProviderSessionId(request.appSessionId), null);
  assert.equal(writer.userId, request.userId);
  assert.equal(writer.isWebSocketWriter, true);
});

test('an unqualified legacy complete cannot preempt a later explicit success', async () => {
  const adapter = new LegacyProviderRuntimeAdapter({
    async run(_command, _options, writer) {
      writer.send({
        kind: 'complete',
        provider: 'codex',
        sessionId: 'native-codex-session-1',
      });
      writer.send({
        kind: 'complete',
        provider: 'codex',
        sessionId: 'native-codex-session-1',
        exitCode: 0,
        success: true,
      });
    },
    abort() {
      return false;
    },
  });
  const output = createSink();

  const outcome = await adapter.run(
    { ...request, provider: 'codex' },
    output.sink,
    context,
    new AbortController().signal,
  );

  assert.deepEqual(outcome, {
    status: 'completed',
    providerSessionId: 'native-codex-session-1',
    exitCode: 0,
  });
  assert.deepEqual(output.bindings, [{
    providerSessionId: 'native-codex-session-1',
    artifactPath: undefined,
  }]);
  assert.deepEqual(output.events, []);
});

test('adapter bridges AbortSignal to legacy abort and resolves aborted without a legacy terminal', async () => {
  const abortCalls: string[] = [];
  const neverSettles = new Promise<void>(() => {});
  const adapter = new LegacyProviderRuntimeAdapter({
    async run() {
      await neverSettles;
    },
    abort(sessionId) {
      abortCalls.push(sessionId);
      return true;
    },
  });
  const controller = new AbortController();

  const run = adapter.run(request, createSink().sink, context, controller.signal);
  await Promise.resolve();
  controller.abort();

  assert.deepEqual(await run, {
    status: 'aborted',
    providerSessionId: null,
    exitCode: 1,
  });
  assert.deepEqual(abortCalls, ['app-session-1']);
});

test('fresh app sessions stay fresh when a legacy runtime resolves its app id', async () => {
  const delegatedSessionIds: Array<string | null | undefined> = [];
  const resolvedSessionIds: Array<string | null> = [];
  const adapter = new LegacyProviderRuntimeAdapter({
    async run(_command, options, writer, receivedContext) {
      resolvedSessionIds.push(receivedContext.resolveProviderSessionId(
        options.sessionId as string,
      ));
      writer.send({
        kind: 'complete',
        provider: 'claude',
        sessionId: options.sessionId,
        exitCode: 0,
        success: true,
      });
    },
    abort() {
      return false;
    },
  });
  const fallbackContext: ProviderRuntimeContext = {
    ...context,
    resolveProviderSessionId(sessionId) {
      delegatedSessionIds.push(sessionId);
      return sessionId ?? null;
    },
  };

  const outcome = await adapter.run(
    request,
    createSink().sink,
    fallbackContext,
    new AbortController().signal,
  );

  assert.deepEqual(resolvedSessionIds, [null]);
  assert.deepEqual(delegatedSessionIds, []);
  assert.equal(outcome.providerSessionId, null);
});

test('R11: coordinator abort before legacy startup never starts the legacy runtime', async () => {
  let legacyRunCalls = 0;
  const abortCalls: string[] = [];
  const adapter = new LegacyProviderRuntimeAdapter({
    async run() {
      legacyRunCalls += 1;
      await new Promise<void>(() => {});
    },
    abort(sessionId) {
      abortCalls.push(sessionId);
      return false;
    },
  });
  const provider: ProviderDefinition = {
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
    runtime: adapter,
    models: {} as never,
    auth: {} as never,
    sessions: {} as never,
    sessionSynchronizer: {} as never,
  };
  const coordinator = new ProviderRunCoordinator({
    createRunId: () => request.runId,
    resolveProvider: () => provider,
  });
  const events: unknown[] = [];
  const { runId: _runId, ...coordinatorRequest } = request;

  const run = coordinator.run(
    coordinatorRequest,
    { send: (event) => events.push(event) },
    context,
  );
  await Promise.resolve();
  assert.equal(coordinator.abort(request.appSessionId), true);

  assert.deepEqual(await run, {
    status: 'aborted',
    providerSessionId: null,
    exitCode: 1,
  });
  await Promise.resolve();
  assert.equal(legacyRunCalls, 0);
  assert.deepEqual(abortCalls, [request.appSessionId]);
  assert.equal(events.length, 1);
});

test('R7: authoritative legacy binding is preserved when app and native ids match', async () => {
  const sameIdRequest = {
    ...request,
    appSessionId: 'same-id',
  };
  const adapter = new LegacyProviderRuntimeAdapter({
    async run(_command, _options, writer) {
      writer.setSessionId?.('same-id');
      writer.send({
        kind: 'session_created',
        provider: 'claude',
        sessionId: 'same-id',
        newSessionId: 'same-id',
      });
      writer.send({
        kind: 'complete',
        provider: 'claude',
        sessionId: 'same-id',
        exitCode: 0,
        success: true,
      });
    },
    abort() {
      return false;
    },
  });
  const provider: ProviderDefinition = {
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
    runtime: adapter,
    models: {} as never,
    auth: {} as never,
    sessions: {} as never,
    sessionSynchronizer: {} as never,
  };
  const coordinator = new ProviderRunCoordinator({
    createRunId: () => sameIdRequest.runId,
    resolveProvider: () => provider,
  });
  const events: Array<{ kind?: string }> = [];
  const bindings: string[] = [];
  const { runId: _runId, ...coordinatorRequest } = sameIdRequest;

  const outcome = await coordinator.run(
    coordinatorRequest,
    {
      send: (event) => events.push(event as { kind?: string }),
      setSessionId: (providerSessionId) => bindings.push(providerSessionId),
    },
    context,
  );

  assert.deepEqual(outcome, {
    status: 'completed',
    providerSessionId: 'same-id',
    exitCode: 0,
  });
  assert.deepEqual(bindings, ['same-id']);
  assert.deepEqual(events.map((event) => event.kind), ['session_created', 'complete']);
});

test('a legacy complete carrying only the app id cannot invent a native binding', async () => {
  const adapter = new LegacyProviderRuntimeAdapter({
    async run(_command, _options, writer) {
      writer.send({
        kind: 'complete',
        provider: 'claude',
        sessionId: request.appSessionId,
        actualSessionId: request.appSessionId,
        exitCode: 0,
        success: true,
      });
    },
    abort() {
      return false;
    },
  });
  const output = createSink();

  const outcome = await adapter.run(
    request,
    output.sink,
    context,
    new AbortController().signal,
  );

  assert.deepEqual(outcome, {
    status: 'completed',
    providerSessionId: null,
    exitCode: 0,
  });
  assert.deepEqual(output.bindings, []);
  assert.deepEqual(output.events, []);
});

test('adapter converts a legacy rejection into a failed outcome', async () => {
  const runtimeError = new Error('legacy runtime crashed');
  const adapter = new LegacyProviderRuntimeAdapter({
    async run() {
      throw runtimeError;
    },
    abort() {
      return false;
    },
  });

  const outcome = await adapter.run(
    request,
    createSink().sink,
    context,
    new AbortController().signal,
  );

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.error, runtimeError);
});

test('adapter treats legacy resolve without complete as failure', async () => {
  const adapter = new LegacyProviderRuntimeAdapter({
    async run() {},
    abort() {
      return false;
    },
  });

  assert.deepEqual(
    await adapter.run(
      request,
      createSink().sink,
      context,
      new AbortController().signal,
    ),
    {
      status: 'failed',
      providerSessionId: null,
      exitCode: 1,
    },
  );
});

test('adapter exposes the legacy permission gateway unchanged', () => {
  const permissions = {
    resolve() {},
    listPending() {
      return [];
    },
  };
  const adapter = new LegacyProviderRuntimeAdapter({
    async run() {},
    abort() {
      return false;
    },
    permissions,
  });

  assert.equal(adapter.permissions, permissions);
});
