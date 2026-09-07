import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProviderRuntime, ProviderDefinition } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  NormalizedMessage,
  ProviderRunRequest,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run(request) {
      return {
        status: 'completed',
        providerSessionId: request.providerSessionId,
        exitCode: 0,
      };
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): ProviderDefinition {
  return {
    id,
    descriptor: {
      permissionModes: ['default'],
      defaultPermissionMode: 'default',
      supportsImages: true,
      supportsFiles: true,
      supportsAbort: true,
      supportsPermissionRequests: false,
      supportsEffort: true,
    },
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as ProviderDefinition;
}

function createService(
  providers: ProviderDefinition[],
  overrides: Parameters<typeof createProviderRuntimeService>[0] = {},
) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        models: { OPTIONS: [], DEFAULT: 'default-model' },
        cache: {
          updatedAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
          source: 'fresh',
        },
      };
    },
    createRunId: () => 'run-1',
    ...overrides,
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
    'pi',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
});

test('projects compatibility calls through the coordinator and aborts by app session', async () => {
  const requests: ProviderRunRequest[] = [];
  const observedSignals: AbortSignal[] = [];
  const runtime = createRuntime({
    async run(request, sink, context, signal) {
      requests.push(request);
      observedSignals.push(signal);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);

      if (request.command === 'wait') {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 'aborted',
          providerSessionId: request.providerSessionId,
          exitCode: 1,
        };
      }

      sink.bindProviderSession({ providerSessionId: 'native-session-1' });
      sink.emit({
        id: 'event-1',
        kind: 'text',
        provider: 'claude',
        sessionId: 'native-session-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: 'hello',
      });
      return {
        status: 'completed',
        providerSessionId: 'native-session-1',
        exitCode: 0,
      };
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const events: NormalizedMessage[] = [];
  const bindings: string[] = [];
  const writer = {
    userId: 'user-1',
    send(data: unknown) {
      events.push(data as NormalizedMessage);
    },
    setSessionId(providerSessionId: string) {
      bindings.push(providerSessionId);
    },
  };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.deepEqual(
    await service.getRunner('claude')(
      'hello',
      {
        sessionId: 'session-1',
        model: 'sonnet',
        permissionMode: 'default',
        cwd: '/workspace',
      },
      writer,
    ),
    {
      status: 'completed',
      providerSessionId: 'native-session-1',
      exitCode: 0,
    },
  );
  assert.deepEqual(requests[0], {
    runId: 'run-1',
    provider: 'claude',
    appSessionId: 'session-1',
    providerSessionId: 'native-session-1',
    command: 'hello',
    cwd: '/workspace',
    projectPath: undefined,
    artifactPath: undefined,
    model: 'sonnet',
    effort: undefined,
    permissionMode: 'default',
    sessionSummary: undefined,
    clientMessageId: undefined,
    images: undefined,
    files: undefined,
    attachments: undefined,
    toolsSettings: undefined,
    skipPermissions: undefined,
    userId: 'user-1',
  });
  assert.deepEqual(bindings, []);
  assert.deepEqual(events.map((event) => event.kind), [
    'text',
    'complete',
  ]);

  const waitingRun = service.getRunner('claude')(
    'wait',
    { sessionId: 'session-2' },
    { send() {} },
  );
  await Promise.resolve();
  await assert.rejects(
    () => service.abort('cursor', 'session-2'),
    /Missing provider: cursor/,
  );
  assert.equal(observedSignals[1]?.aborted, false);
  assert.equal(await service.abort('claude', 'session-2'), true);
  assert.deepEqual(await waitingRun, {
    status: 'aborted',
    providerSessionId: 'native-session-2',
    exitCode: 1,
  });
  assert.equal(observedSignals[1]?.aborted, true);
  assert.equal(await service.abort('claude', 'session-2'), false);
});

test('an explicit null provider session id keeps an app-identified run fresh', async () => {
  const requests: ProviderRunRequest[] = [];
  const nativeLookups: string[] = [];
  const runtime = createRuntime({
    async run(request) {
      requests.push(request);
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
  });
  const service = createService([createProvider('claude', runtime)], {
    resolveProviderSessionId(sessionId) {
      if (sessionId) nativeLookups.push(sessionId);
      return sessionId ? `native-${sessionId}` : null;
    },
  });

  await service.getRunner('claude')(
    'start fresh',
    {
      sessionId: 'app-session-fresh',
      providerSessionId: null,
    },
    { send() {} },
  );

  assert.deepEqual(nativeLookups, []);
  assert.equal(requests[0]?.appSessionId, 'app-session-fresh');
  assert.equal(requests[0]?.providerSessionId, null);
});

test('records an explicit Agent model before a fresh runtime starts', async () => {
  const operations: string[] = [];
  const recordedModels: Array<{ provider: LLMProvider; sessionId: string; model: string }> = [];
  const runtime = createRuntime({
    async run(request) {
      operations.push('runtime');
      assert.equal(request.model, 'haiku');
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
  });
  const service = createService([createProvider('claude', runtime)], {
    sessionIdentity: {
      ensureAppSession() {
        operations.push('ensure');
      },
      assignProviderSessionId() {
        operations.push('assign');
      },
    },
    recordSessionModel(provider, sessionId, model) {
      operations.push('model');
      recordedModels.push({ provider, sessionId, model });
    },
  });

  await service.getRunner('claude')(
    'hello',
    {
      sessionId: 'agent-http-session',
      providerSessionId: null,
      projectPath: '/workspace/project',
      model: 'haiku',
    },
    { send() {} },
  );

  assert.deepEqual(operations, ['ensure', 'model', 'runtime']);
  assert.deepEqual(recordedModels, [{
    provider: 'claude',
    sessionId: 'agent-http-session',
    model: 'haiku',
  }]);
});

test('records an explicit Agent model when resuming an existing app session', async () => {
  const operations: string[] = [];
  const recordedModels: Array<{ provider: LLMProvider; sessionId: string; model: string }> = [];
  const runtime = createRuntime({
    async run(request) {
      operations.push('runtime');
      assert.equal(request.providerSessionId, 'native-existing');
      return { status: 'completed', providerSessionId: 'native-existing', exitCode: 0 };
    },
  });
  const service = createService([createProvider('claude', runtime)], {
    resolveProviderSessionId: (sessionId) => {
      operations.push('lookup');
      return sessionId ? 'native-existing' : null;
    },
    sessionIdentity: {
      ensureAppSession() {
        operations.push('ensure');
      },
      assignProviderSessionId() {
        operations.push('assign');
      },
    },
    recordSessionModel(provider, sessionId, model) {
      operations.push('model');
      recordedModels.push({ provider, sessionId, model });
    },
  });

  await service.getRunner('claude')(
    'resume',
    {
      sessionId: 'agent-http-session',
      providerSessionId: undefined,
      projectPath: '/workspace/project',
      model: 'sonnet',
    },
    { send() {} },
  );

  assert.deepEqual(operations, ['lookup', 'model', 'runtime']);
  assert.deepEqual(recordedModels, [{
    provider: 'claude',
    sessionId: 'agent-http-session',
    model: 'sonnet',
  }]);
});

test('run completes normally when session-model recording rejects on the auth gate', async () => {
  const original = providerModelsService.setSessionModel;
  providerModelsService.setSessionModel = async () => {
    throw new AppError('provider 未安装或未认证', {
      code: 'PROVIDER_NOT_AUTHENTICATED',
      statusCode: 401,
    });
  };
  const warns: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const runtime = createRuntime();
    const service = createService([createProvider('claude', runtime)], {
      sessionIdentity: {
        ensureAppSession() {},
        assignProviderSessionId() {},
      },
    });

    const outcome = await service.getRunner('claude')(
      'hello',
      { sessionId: 'session-1', projectPath: '/workspace/project', model: 'haiku' },
      { send() {} },
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outcome, {
      status: 'completed',
      providerSessionId: 'native-session-1',
      exitCode: 0,
    });
    assert.equal(warns.length, 0);
    assert.equal(unhandled.length, 0);
  } finally {
    providerModelsService.setSessionModel = original;
    console.warn = originalWarn;
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('run completes and warns when session-model recording fails for a non-gate reason', async () => {
  const original = providerModelsService.setSessionModel;
  providerModelsService.setSessionModel = async () => {
    throw new Error('db write failed');
  };
  const warns: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args);
  try {
    const runtime = createRuntime();
    const service = createService([createProvider('claude', runtime)], {
      sessionIdentity: {
        ensureAppSession() {},
        assignProviderSessionId() {},
      },
    });

    const outcome = await service.getRunner('claude')(
      'hello',
      { sessionId: 'session-1', projectPath: '/workspace/project', model: 'haiku' },
      { send() {} },
    );

    assert.deepEqual(outcome, {
      status: 'completed',
      providerSessionId: 'native-session-1',
      exitCode: 0,
    });
    assert.equal(warns.length, 1);
  } finally {
    providerModelsService.setSessionModel = original;
    console.warn = originalWarn;
  }
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});
