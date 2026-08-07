import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readProviderSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createWriter() {
  const messages: unknown[] = [];
  return {
    messages,
    writer: {
      userId: null,
      isWebSocketWriter: true,
      send(message: unknown) {
        messages.push(message);
      },
      setSessionId() {},
    },
  };
}

function createRuntimeContext(overrides: Record<string, unknown> = {}) {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId: string | undefined, model: string | undefined) => model,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end(): void };
  kill(): boolean;
  sessionId?: string;
};

function createChildProcessDouble(): FakeChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end() {} },
    kill: () => true,
  }) as FakeChildProcess;
}

function createCompletingChildProcess(): FakeChildProcess {
  const processDouble = createChildProcessDouble();
  queueMicrotask(() => processDouble.emit('close', 0));
  return processDouble;
}

function createCompletedClaudeQuery() {
  return {
    async interrupt() {},
    async *[Symbol.asyncIterator]() {},
  };
}

function createControlledClaudeQuery(options: {
  holdInterrupt?: boolean;
  finishOnInterrupt?: boolean;
} = {}) {
  const nextResult = createDeferred<IteratorResult<unknown>>();
  const nextRequested = createDeferred<void>();
  const interruptStarted = createDeferred<void>();
  const interruptRelease = createDeferred<void>();
  let interruptCalls = 0;
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    nextResult.resolve({ done: true, value: undefined });
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    nextResult.reject(error);
  };

  const queryDouble = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      nextRequested.resolve(undefined);
      return nextResult.promise;
    },
    async interrupt() {
      interruptCalls += 1;
      interruptStarted.resolve(undefined);
      if (options.holdInterrupt) {
        await interruptRelease.promise;
      }
      if (options.finishOnInterrupt !== false) {
        finish();
      }
    },
  };

  return {
    queryDouble,
    nextRequested: nextRequested.promise,
    interruptStarted: interruptStarted.promise,
    releaseInterrupt: () => interruptRelease.resolve(undefined),
    finish,
    fail,
    get interruptCalls() {
      return interruptCalls;
    },
  };
}

test('4.4 Claude registers the adapter and drops abort terminal bookkeeping', () => {
  const providerSource = readProviderSource('../list/claude/claude.provider.ts');
  const runtimeSource = readProviderSource('../list/claude/claude-runtime.provider.js');

  assert.match(
    providerSource,
    /new LegacyProviderRuntimeAdapter\(claudeRuntime\)/,
  );
  assert.doesNotMatch(runtimeSource, /\babortedSessionIds\b/);
  assert.doesNotMatch(runtimeSource, /\bstatus:\s*['"]active['"]/);
  assert.doesNotMatch(runtimeSource, /\bsession\.status\s*=\s*['"]aborted['"]/);
  assert.doesNotMatch(runtimeSource, /\bsession\.status\s*===\s*['"]active['"]/);
});

test('4.4 Codex registers the adapter and drops session terminal status', () => {
  const providerSource = readProviderSource('../list/codex/codex.provider.ts');
  const runtimeSource = readProviderSource('../list/codex/codex-runtime.provider.js');

  assert.match(
    providerSource,
    /new LegacyProviderRuntimeAdapter\(codexRuntime\)/,
  );
  assert.doesNotMatch(runtimeSource, /\bsession\??\.status\b/);
  assert.doesNotMatch(runtimeSource, /completedSessionCleanupTimer/);
});

test('4.4 Cursor registers the adapter and drops duplicate terminal bookkeeping', () => {
  const providerSource = readProviderSource('../list/cursor/cursor.provider.ts');
  const runtimeSource = readProviderSource('../list/cursor/cursor-runtime.provider.js');

  assert.match(
    providerSource,
    /new LegacyProviderRuntimeAdapter\(cursorRuntime\)/,
  );
  assert.doesNotMatch(runtimeSource, /\bcompleteSent\b/);
  assert.doesNotMatch(runtimeSource, /\bcursorProcess\.aborted\b/);
  assert.doesNotMatch(runtimeSource, /\bprocess\.aborted\b/);
  assert.doesNotMatch(runtimeSource, /new Promise\s*\(\s*async\b/);
});

test('4.4 Cursor propagates resume-model rejection before spawning', async () => {
  const { cursorRuntime } = await import('../list/cursor/cursor-runtime.provider.js');
  const runtimeError = new Error('resume model lookup failed');

  await assert.rejects(
    cursorRuntime.run(
      'hello',
      { sessionId: 'app-session-1' },
      { send() {} },
      {
        resolveProviderSessionId: () => 'native-session-1',
        resolveResumeModel: async () => {
          throw runtimeError;
        },
      },
    ),
    (error: unknown) => error === runtimeError,
  );
});

test('4.4 OpenCode registers the adapter and drops duplicate terminal bookkeeping', () => {
  const providerSource = readProviderSource('../list/opencode/opencode.provider.ts');
  const runtimeSource = readProviderSource('../list/opencode/opencode-runtime.provider.js');

  assert.match(
    providerSource,
    /new LegacyProviderRuntimeAdapter\(opencodeRuntime\)/,
  );
  assert.doesNotMatch(runtimeSource, /\bcompleteSent\b/);
  assert.doesNotMatch(runtimeSource, /\bopencodeProcess\.aborted\b/);
  assert.doesNotMatch(runtimeSource, /\bprocess\.aborted\b/);
});

test('4.4 cancellation during async initialization never starts native execution', async (t) => {
  await t.test('Claude stops after the async model catalog resolves', async () => {
    const { queryClaudeSDK } = await import('../list/claude/claude-runtime.provider.js');
    const catalogStarted = createDeferred<void>();
    const catalog = createDeferred<{ OPTIONS: never[]; DEFAULT: string }>();
    const abortController = new AbortController();
    let nativeExecutions = 0;
    const { writer } = createWriter();

    const runPromise = queryClaudeSDK(
      'hello',
      { sessionId: 'cancel-claude-init', signal: abortController.signal },
      writer,
      createRuntimeContext({
        getProviderModels: () => {
          catalogStarted.resolve(undefined);
          return catalog.promise;
        },
      }),
      {
        query: () => {
          nativeExecutions += 1;
          return createCompletedClaudeQuery();
        },
      },
    );

    await catalogStarted.promise;
    abortController.abort();
    catalog.resolve({ OPTIONS: [], DEFAULT: '' });
    await runPromise;

    assert.equal(nativeExecutions, 0);
  });

  await t.test('Codex stops after the async model catalog resolves', async () => {
    const { queryCodex } = await import('../list/codex/codex-runtime.provider.js');
    const catalogStarted = createDeferred<void>();
    const catalog = createDeferred<{ OPTIONS: never[]; DEFAULT: string }>();
    const abortController = new AbortController();
    let nativeExecutions = 0;
    const { writer } = createWriter();
    const thread = {
      id: 'native-codex-cancelled',
      async runStreamed() {
        return {
          events: (async function* () {})(),
        };
      },
    };

    const runPromise = queryCodex(
      'hello',
      { sessionId: 'cancel-codex-init', signal: abortController.signal },
      writer,
      createRuntimeContext({
        getProviderModels: () => {
          catalogStarted.resolve(undefined);
          return catalog.promise;
        },
      }),
      {
        createCodex: () => ({
          startThread() {
            nativeExecutions += 1;
            return thread;
          },
          resumeThread() {
            nativeExecutions += 1;
            return thread;
          },
        }),
      },
    );

    await catalogStarted.promise;
    abortController.abort();
    catalog.resolve({ OPTIONS: [], DEFAULT: '' });
    await runPromise;

    assert.equal(nativeExecutions, 0);
  });

  await t.test('Cursor stops after async resume-model resolution', async () => {
    const { spawnCursor } = await import('../list/cursor/cursor-runtime.provider.js');
    const modelLookupStarted = createDeferred<void>();
    const resolvedModel = createDeferred<string>();
    const abortController = new AbortController();
    let nativeExecutions = 0;
    const { writer } = createWriter();

    const runPromise = spawnCursor(
      'hello',
      { sessionId: 'cancel-cursor-init', signal: abortController.signal },
      writer,
      createRuntimeContext({
        resolveResumeModel: () => {
          modelLookupStarted.resolve(undefined);
          return resolvedModel.promise;
        },
      }),
      {
        spawn: () => {
          nativeExecutions += 1;
          return createCompletingChildProcess();
        },
      },
    );

    await modelLookupStarted.promise;
    abortController.abort();
    resolvedModel.resolve('composer-1');
    await runPromise;

    assert.equal(nativeExecutions, 0);
  });

  await t.test('OpenCode stops after the async model catalog resolves', async () => {
    const { spawnOpenCode } = await import('../list/opencode/opencode-runtime.provider.js');
    const catalogStarted = createDeferred<void>();
    const catalog = createDeferred<{ OPTIONS: never[]; DEFAULT: string }>();
    const abortController = new AbortController();
    let nativeExecutions = 0;
    const { writer } = createWriter();

    const runPromise = spawnOpenCode(
      'hello',
      { sessionId: 'cancel-opencode-init', signal: abortController.signal },
      writer,
      createRuntimeContext({
        getProviderModels: () => {
          catalogStarted.resolve(undefined);
          return catalog.promise;
        },
      }),
      {
        spawn: () => {
          nativeExecutions += 1;
          return createCompletingChildProcess();
        },
      },
    );

    await catalogStarted.promise;
    abortController.abort();
    catalog.resolve({ OPTIONS: [], DEFAULT: '' });
    await runPromise;

    assert.equal(nativeExecutions, 0);
  });
});

test('Codex applies the selected model default when the composer leaves effort at default', async () => {
  const { queryCodex } = await import('../list/codex/codex-runtime.provider.js');
  const { writer } = createWriter();
  let receivedThreadOptions: Record<string, unknown> | undefined;
  const thread = {
    id: 'native-codex-effort-default',
    async runStreamed() {
      return {
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-codex-effort-default' };
          yield { type: 'turn.completed', usage: null };
        })(),
      };
    },
  };

  await queryCodex(
    'hello',
    {
      sessionId: 'app-codex-effort-default',
      model: 'gpt-5.4',
      effort: 'default',
      permissionMode: 'acceptEdits',
    },
    writer,
    createRuntimeContext({
      getProviderModels: async () => ({
        OPTIONS: [{
          value: 'gpt-5.4',
          label: 'gpt-5.4',
          effort: {
            default: 'medium',
            values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
          },
        }],
        DEFAULT: 'gpt-5.4',
      }),
    }),
    {
      createCodex: () => ({
        startThread(options: Record<string, unknown>) {
          receivedThreadOptions = options;
          return thread;
        },
        resumeThread(_sessionId: string, options: Record<string, unknown>) {
          receivedThreadOptions = options;
          return thread;
        },
      }),
    },
  );

  assert.equal(receivedThreadOptions?.model, 'gpt-5.4');
  assert.equal(receivedThreadOptions?.modelReasoningEffort, 'medium');
});

test('4.4 Cursor workspace-trust retry does not spawn after cancellation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { spawnCursor } = await import('../list/cursor/cursor-runtime.provider.js');
  const abortController = new AbortController();
  const { writer } = createWriter();
  let nativeExecutions = 0;

  await spawnCursor(
    'hello',
    { sessionId: 'cancel-cursor-trust-retry', signal: abortController.signal },
    writer,
    createRuntimeContext(),
    {
      spawn: () => {
        nativeExecutions += 1;
        const processDouble = createChildProcessDouble();
        queueMicrotask(() => {
          processDouble.stderr.emit('data', Buffer.from('workspace trust required'));
          abortController.abort();
          processDouble.emit('close', 1);
        });
        return processDouble;
      },
    },
  );

  assert.equal(nativeExecutions, 1);
});

test('4.4 Claude tool approval observes the run AbortSignal', async () => {
  const {
    queryClaudeSDK,
    resolveToolApproval,
  } = await import('../list/claude/claude-runtime.provider.js');
  const abortController = new AbortController();
  const query = createControlledClaudeQuery();
  const { messages, writer } = createWriter();
  let canUseTool:
    | ((toolName: string, input: unknown, context: unknown) => Promise<unknown>)
    | undefined;

  const runPromise = queryClaudeSDK(
    'hello',
    { sessionId: 'claude-approval-signal', signal: abortController.signal },
    writer,
    createRuntimeContext(),
    {
      query: ({ options }: {
        options: {
          canUseTool(toolName: string, input: unknown, context: unknown): Promise<unknown>;
        };
      }) => {
        canUseTool = options.canUseTool;
        return query.queryDouble;
      },
    },
  );
  await query.nextRequested;
  assert.ok(canUseTool);

  const approvalPromise = canUseTool('AskUserQuestion', { question: 'Continue?' }, {});
  abortController.abort();
  let timeout: NodeJS.Timeout | undefined;
  const observed = await Promise.race([
    approvalPromise.then((value) => ({ status: 'resolved' as const, value })),
    new Promise<{ status: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: 'timeout' }), 100);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (observed.status === 'timeout') {
    const permissionRequest = messages.find((message) => (
      typeof message === 'object'
      && message !== null
      && 'kind' in message
      && message.kind === 'permission_request'
    )) as { requestId?: string } | undefined;
    if (permissionRequest?.requestId) {
      resolveToolApproval(permissionRequest.requestId, { allow: false });
      await approvalPromise;
    }
  }

  query.finish();
  await runPromise;

  assert.equal(observed.status, 'resolved');
  if (observed.status === 'resolved') {
    assert.deepEqual(observed.value, {
      behavior: 'deny',
      message: 'Permission request cancelled',
    });
  }
});

test('4.4 Claude cleanup cannot remove a newer generation for the same app session', async (t) => {
  const {
    abortClaudeSDKSession,
    queryClaudeSDK,
  } = await import('../list/claude/claude-runtime.provider.js');

  await t.test('normal completion keeps the newer generation active', async () => {
    const firstQuery = createControlledClaudeQuery();
    const secondQuery = createControlledClaudeQuery();
    const { writer: firstWriter } = createWriter();
    const { writer: secondWriter } = createWriter();
    const sessionId = 'claude-generation-normal';
    const firstRun = queryClaudeSDK(
      'first',
      { sessionId },
      firstWriter,
      createRuntimeContext(),
      { query: () => firstQuery.queryDouble },
    );
    await firstQuery.nextRequested;
    const secondRun = queryClaudeSDK(
      'second',
      { sessionId },
      secondWriter,
      createRuntimeContext(),
      { query: () => secondQuery.queryDouble },
    );
    await secondQuery.nextRequested;

    firstQuery.finish();
    await firstRun;
    const abortedNewGeneration = await abortClaudeSDKSession(sessionId);
    if (!abortedNewGeneration) secondQuery.finish();
    await secondRun;

    assert.equal(abortedNewGeneration, true);
    assert.equal(secondQuery.interruptCalls, 1);
  });

  await t.test('an older abort cleanup keeps the newer generation active', async () => {
    const firstQuery = createControlledClaudeQuery({
      holdInterrupt: true,
      finishOnInterrupt: false,
    });
    const secondQuery = createControlledClaudeQuery();
    const { writer: firstWriter } = createWriter();
    const { writer: secondWriter } = createWriter();
    const sessionId = 'claude-generation-abort';
    const firstRun = queryClaudeSDK(
      'first',
      { sessionId },
      firstWriter,
      createRuntimeContext(),
      { query: () => firstQuery.queryDouble },
    );
    await firstQuery.nextRequested;
    const firstAbort = abortClaudeSDKSession(sessionId);
    await firstQuery.interruptStarted;

    const secondRun = queryClaudeSDK(
      'second',
      { sessionId },
      secondWriter,
      createRuntimeContext(),
      { query: () => secondQuery.queryDouble },
    );
    await secondQuery.nextRequested;
    firstQuery.releaseInterrupt();
    await firstAbort;

    const abortedNewGeneration = await abortClaudeSDKSession(sessionId);
    if (!abortedNewGeneration) secondQuery.finish();
    firstQuery.finish();
    await Promise.all([firstRun, secondRun]);

    assert.equal(abortedNewGeneration, true);
    assert.equal(secondQuery.interruptCalls, 1);
  });

  await t.test('an older error cleanup keeps the newer generation active', async (subtest) => {
    subtest.mock.method(console, 'error', () => {});
    const firstQuery = createControlledClaudeQuery();
    const secondQuery = createControlledClaudeQuery();
    const { writer: firstWriter } = createWriter();
    const { writer: secondWriter } = createWriter();
    const sessionId = 'claude-generation-error';
    const firstRun = queryClaudeSDK(
      'first',
      { sessionId },
      firstWriter,
      createRuntimeContext(),
      { query: () => firstQuery.queryDouble },
    );
    await firstQuery.nextRequested;
    const secondRun = queryClaudeSDK(
      'second',
      { sessionId },
      secondWriter,
      createRuntimeContext(),
      { query: () => secondQuery.queryDouble },
    );
    await secondQuery.nextRequested;

    firstQuery.fail(new Error('older generation failed'));
    await firstRun;
    const abortedNewGeneration = await abortClaudeSDKSession(sessionId);
    if (!abortedNewGeneration) secondQuery.finish();
    await secondRun;

    assert.equal(abortedNewGeneration, true);
    assert.equal(secondQuery.interruptCalls, 1);
  });
});

test('4.6 legacy adapter declares and tracks its finite exit condition', () => {
  const adapterSource = readProviderSource('../adapters/legacy-provider-runtime.adapter.ts');
  const trackingItem = readProviderSource(
    '../../../../openspec/changes/refactor-provider-seams/legacy-runtime-adapter-exit.md',
  );

  assert.match(adapterSource, /OpenSpec task 4\.6/);
  assert.match(adapterSource, /legacy-runtime-adapter-exit\.md/);
  for (const provider of ['Claude', 'Codex', 'Cursor', 'OpenCode']) {
    assert.match(trackingItem, new RegExp(`${provider}.*JavaScript.*TypeScript`));
  }
  assert.match(
    trackingItem,
    /all four runtimes.*implement `IProviderRuntime` directly.*delete `LegacyProviderRuntimeAdapter`/is,
  );
});
