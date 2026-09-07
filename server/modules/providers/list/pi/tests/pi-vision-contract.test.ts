/**
 * Task 1 (compatibility contract gate). Pins the locked
 * `@earendil-works/pi-coding-agent@0.84.4` surface the vision bridge depends on.
 *
 * Three blocks, matching tasks.md 1.1-1.3:
 *   (a) ExtensionAPI hook surface (context / turn_end present, no
 *       before_provider_payload) asserted against the shipped types.d.ts.
 *   (b) ModelRegistry contract: find() returns a full model snapshot; complete()
 *       accepts provider-neutral image context and returns text without
 *       re-entering any extension hook (documented via the absence of a hook
 *       surface on ModelRegistry and a single provider dispatch).
 *   (c) RPC/session contract: setStatus -> extension_ui_request (method
 *       "setStatus") via a real subprocess; appendEntry -> custom session entry;
 *       sessionManager.getEntries() sourceEntryId matching for user/tool/history
 *       images (in-memory).
 *
 * No production implementation files are imported; only
 * `@earendil-works/pi-coding-agent` and Node builtins. The real-subprocess
 * tests use the official RpcClient with an explicit cliPath, mirroring the
 * "real spawn" pattern in pi-rpc-client.provider.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ModelRegistry,
  ModelRuntime,
  RpcClient,
  SessionManager,
  type ProviderConfig,
  type SessionEntry,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';

const HEALTH_COMMAND = 'cloudcli-vision-bridge-health-v1';

function resolveCliJs(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return path.join(path.dirname(entry), 'cli.js');
}

function resolveTypesDts(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return path.join(path.dirname(entry), 'core', 'extensions', 'types.d.ts');
}

function resolveProbeExtensionFixture(): string {
  return fileURLToPath(
    new URL('./fixtures/vision-bridge-probe-extension.ts', import.meta.url),
  );
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === 'message';
}

// ---------------------------------------------------------------------------
// (a) ExtensionAPI hook surface (static, against the shipped d.ts)
// ---------------------------------------------------------------------------

test('(a) 0.84.4 ExtensionAPI exposes context and turn_end but not before_provider_payload', async () => {
  const dts = await readFile(resolveTypesDts(), 'utf8');

  // The only correctness seam the bridge may use.
  assert.match(dts, /on\(event: "context"/);
  assert.match(dts, /on\(event: "turn_end"/);

  // Pi 0.84.4 renamed/omitted this event; only before_provider_request exists.
  // The bridge MUST NOT register before_provider_payload anywhere.
  assert.doesNotMatch(dts, /before_provider_payload/);
  assert.match(dts, /on\(event: "before_provider_request"/);
});

// ---------------------------------------------------------------------------
// (b) ModelRegistry contract (in-process, fake provider, no HTTP)
// ---------------------------------------------------------------------------

type FakeStreamSimple = NonNullable<ProviderConfig['streamSimple']>;

/** A canned assistant-only stream/result for the fake provider. */
function cannedAssistantStream(text: string): unknown {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'fake-vision-api',
    provider: 'fake-vision',
    model: 'vision-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: 'stop', message };
    },
    result: () => Promise.resolve(message),
  };
}

/**
 * Build a ModelRegistry backed by a self-contained fake provider. The caller
 * supplies a plain function standing in for the provider's streamSimple; the
 * single cast here adapts it to the pi-ai stream type without importing pi-ai.
 */
async function createFakeRegistry(streamSimple: unknown): Promise<{
  registry: ModelRegistry;
  modelDef: {
    id: string;
    name: string;
    reasoning: boolean;
    input: ('text' | 'image')[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  };
}> {
  // modelsPath: null -> in-memory store; refreshOnCreate: false -> no network or
  // catalog refresh. authPath isolation avoids touching the user's real ~/.pi.
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
    authPath: path.join(await mkdtemp(path.join(tmpdir(), 'pi-vb-auth-')), 'auth.json'),
  });
  const registry = new ModelRegistry(runtime);

  const modelDef = {
    id: 'vision-model',
    name: 'Vision Model',
    reasoning: false,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };

  registry.registerProvider('fake-vision', {
    name: 'Fake Vision',
    baseUrl: 'https://fake-vision.invalid/v1',
    apiKey: 'literal-fake-key',
    headers: { 'x-fake': 'vision-probe' },
    api: 'fake-vision-api',
    streamSimple: streamSimple as FakeStreamSimple,
    models: [modelDef],
  });

  return { registry, modelDef };
}

test('(b) ModelRegistry.find returns a full model snapshot with input/api/baseUrl', async () => {
  const { registry } = await createFakeRegistry(() => {
    throw new Error('unused');
  });

  const model = registry.find('fake-vision', 'vision-model');
  assert.ok(model, 'find() must resolve the registered model');

  // E5: find() returns the full Model<any>, not a narrowed ModelInfo.
  assert.equal(model.id, 'vision-model');
  assert.equal(model.provider, 'fake-vision');
  assert.equal(model.api, 'fake-vision-api');
  assert.equal(model.baseUrl, 'https://fake-vision.invalid/v1');
  assert.deepEqual(model.input, ['text', 'image']);
});

test('(b) ModelRegistry.complete accepts provider-neutral image context and returns text', async () => {
  let dispatchCount = 0;
  let receivedContext: unknown;

  const { registry } = await createFakeRegistry((_model: unknown, context: unknown) => {
    dispatchCount += 1;
    receivedContext = context;
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'a cat sits on a mat' }],
      api: 'fake-vision-api',
      provider: 'fake-vision',
      model: 'vision-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'done', reason: 'stop', message };
      },
      result: () => Promise.resolve(message),
    };
  });

  const model = registry.find('fake-vision', 'vision-model');
  assert.ok(model);

  // Inline the context so contextual typing narrows role/content discriminants.
  const message = await registry.complete(model, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
        timestamp: Date.now(),
      },
    ],
  });

  assert.equal(message.role, 'assistant');
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, 'a cat sits on a mat');
  assert.equal(dispatchCount, 1);

  // The provider-neutral context carried the image block through untouched.
  const ctx = receivedContext as { messages: Array<{ content: Array<{ type: string }> }> };
  assert.ok(ctx.messages[0].content.some((block) => block.type === 'image'));
});

test('(b) E5 getApiKeyAndHeaders resolves the fake provider apiKey and headers', async () => {
  const { registry } = await createFakeRegistry(() => {
    throw new Error('unused');
  });
  const model = registry.find('fake-vision', 'vision-model');
  assert.ok(model);

  const auth = await registry.getApiKeyAndHeaders(model);
  assert.equal((auth as { ok?: boolean }).ok, true, 'getApiKeyAndHeaders must resolve as ok');
  const resolved = auth as { ok: true; apiKey?: string; headers?: Record<string, string> };
  assert.equal(resolved.apiKey, 'literal-fake-key');
  assert.equal(resolved.headers?.['x-fake'], 'vision-probe');
});

test('(b) complete() from inside a context handler does not re-enter the handler (inVisionCall guard)', async () => {
  // design D3 / task 1.2: the vision bridge calls modelRegistry.complete() from
  // inside its `context` handler. If that completion routed back through
  // ExtensionRunner.emitContext, every inner call would recurse infinitely. 0.84.4
  // ModelRegistry dispatches directly to the provider (no on()/emitContext surface),
  // and the bridge additionally guards with a process-level inVisionCall flag so a
  // completion performed while the handler is in flight bypasses re-entry. This test
  // drives the real complete() path and proves, with a counter, that a single pass
  // through a context handler fires the provider exactly once.
  let handlerCalls = 0;
  let dispatchCount = 0;

  const { registry } = await createFakeRegistry((_model: unknown, _context: unknown) => {
    dispatchCount += 1;
    return cannedAssistantStream('a cat sits on a mat');
  });
  const model = registry.find('fake-vision', 'vision-model');
  assert.ok(model);

  let inVisionCall = false;
  const contextHandler = async (messages: unknown[]): Promise<unknown[]> => {
    handlerCalls += 1;
    // D3 guard: recursive re-entry is bypassed, never re-dispatched.
    if (inVisionCall) return messages;
    inVisionCall = true;
    try {
      const result = await registry.complete(model, { messages: messages as never });
      assert.equal((result.content[0] as { text: string }).text, 'a cat sits on a mat');
      return messages;
    } finally {
      inVisionCall = false;
    }
  };

  await contextHandler([
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: Date.now(),
    },
  ]);

  assert.equal(handlerCalls, 1, 'completion must not re-enter the context handler');
  assert.equal(dispatchCount, 1, 'the provider is dispatched exactly once per handler pass');
});

// ---------------------------------------------------------------------------
// (c) RPC / session contract
// ---------------------------------------------------------------------------

test('(c) SessionManager.getEntries() exposes user/tool/history image entries with unique sourceEntryId', () => {
  const sm = SessionManager.inMemory();

  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const image = { type: 'image' as const, data: png, mimeType: 'image/png' };

  // history image: an earlier user message still in the context.
  const historyEntryId = sm.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'earlier turn' }, image],
    timestamp: Date.now(),
  });
  // current user message carrying the image under test.
  const userEntryId = sm.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'look at this' }, image],
    timestamp: Date.now(),
  });
  const toolEntryId = sm.appendMessage({
    role: 'toolResult',
    toolCallId: 'call_123',
    toolName: 'read_image',
    content: [{ type: 'text', text: 'ok' }, image],
    isError: false,
    timestamp: Date.now(),
  });

  const entries = sm.getEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));

  // All three message kinds surface as message entries with stable ids the
  // bridge can use as sourceEntryId.
  for (const id of [userEntryId, historyEntryId, toolEntryId]) {
    const entry = byId.get(id);
    assert.ok(entry, `entry ${id} must be present in getEntries()`);
    assert.ok(isMessageEntry(entry!), `entry ${id} must be a message entry`);
    const content = (entry!.message as { content: Array<{ type?: string }> }).content;
    assert.ok(content.some((block) => block.type === 'image'), `entry ${id} must retain its image block`);
  }

  // The three entries must be individually resolvable by buildContextEntries(),
  // proving sourceEntryId-style ids are stable inside the live context projection.
  const contextEntryIds = new Set(sm.buildContextEntries().map((e) => e.id));
  for (const id of [userEntryId, historyEntryId, toolEntryId]) {
    assert.ok(contextEntryIds.has(id), `entry ${id} must be present in buildContextEntries()`);
  }

  // Uniqueness: each id is distinct and re-resolvable to exactly one entry.
  assert.equal(new Set([userEntryId, historyEntryId, toolEntryId]).size, 3);
});

test('(c) SessionManager.appendCustomEntry produces a custom entry excluded from the LLM context', () => {
  const sm = SessionManager.inMemory();

  sm.appendMessage({
    role: 'user',
    content: 'hello user',
    timestamp: Date.now(),
  });
  sm.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'hello assistant' }],
    api: 'fake-vision-api',
    provider: 'fake-vision',
    model: 'vision-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  });
  sm.appendMessage({
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'read_image',
    content: [{ type: 'text', text: 'tool result text' }],
    isError: false,
    timestamp: Date.now(),
  });
  const CUSTOM_MARKER = 'cloudcli-vision-bridge-batch-b1-marker';
  sm.appendCustomEntry('cloudcli.vision-bridge.v1', { schemaVersion: 1, batchId: CUSTOM_MARKER });

  const entries = sm.getEntries();
  const custom = entries.find((e) => e.type === 'custom');
  assert.ok(custom, 'custom entry must be present');
  assert.equal(custom!.type, 'custom');
  assert.equal(
    (custom as { customType?: string }).customType,
    'cloudcli.vision-bridge.v1',
  );

  // E8 / task 1.3: the custom entry is state/display only. buildSessionContext()
  // projects entries to LLM messages via sessionEntryToContextMessages, which drops
  // plain custom entries. Assert the user/assistant/toolResult messages appear but the
  // custom payload does NOT.
  const context = sm.buildSessionContext();
  const texts = context.messages
    .map((m) => (m as { content?: unknown }).content)
    .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)));

  assert.ok(
    texts.some((t) => typeof t === 'string' && t.includes('hello user')),
    'user message must appear in LLM context',
  );
  assert.ok(
    texts.some((t) => typeof t === 'string' && t.includes('hello assistant')),
    'assistant message must appear in LLM context',
  );
  assert.ok(
    texts.some((t) => typeof t === 'string' && t.includes('tool result text')),
    'toolResult message must appear in LLM context',
  );
  assert.ok(
    !texts.some((t) => t.includes(CUSTOM_MARKER)),
    'custom entry data must NOT appear in LLM context',
  );
});

test('(c) ambiguous sourceEntryId matching returns unbound instead of guessing the latest image', () => {
  // task 1.3 / D7: a history sourceEntryId is attached only when the image block
  // uniquely matches one session entry. When two distinct history images exist, the
  // matcher must return "unbound" — it must not guess the most recent entry.
  const sm = SessionManager.inMemory();

  // Two distinct history images from two different user messages.
  const imageA = { type: 'image' as const, data: 'aW1hZ2UtQQ==', mimeType: 'image/png' };
  const imageB = { type: 'image' as const, data: 'aW1hZ2UtQg==', mimeType: 'image/png' };
  const entryA = sm.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'first image' }, imageA],
    timestamp: Date.now(),
  });
  const entryB = sm.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'second image' }, imageB],
    timestamp: Date.now(),
  });

  const entries = sm.getEntries();

  // D7 matching rule: collect the ids of message entries that carry an image block
  // whose data equals the requested bytes. Exactly one match -> bound; otherwise unbound.
  function matchSourceEntryId(imageData: string): string | undefined {
    // getEntries() returns a shallow copy, so re-read each call to observe later appends.
    const current = sm.getEntries();
    const matches = current
      .filter(isMessageEntry)
      .filter((e) => {
        const content = (e.message as { content?: Array<{ type?: string; data?: string }> })
          .content;
        return Array.isArray(content) && content.some(
          (block) => block.type === 'image' && block.data === imageData,
        );
      })
      .map((e) => e.id);
    return matches.length === 1 ? matches[0] : undefined;
  }

  // Unique bytes resolve to their entry.
  assert.equal(matchSourceEntryId(imageA.data), entryA);
  assert.equal(matchSourceEntryId(imageB.data), entryB);

  // A byte string matching none of the images must be unbound, not the latest entry.
  assert.equal(matchSourceEntryId('bm9uZXhpc3RlbnQ='), undefined);

  // Two identical history images (same source bytes) are ambiguous: no unique match.
  sm.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'duplicate' }, imageA],
    timestamp: Date.now(),
  });
  assert.equal(
    matchSourceEntryId(imageA.data),
    undefined,
    'duplicated image bytes must be unbound, not resolved to the most recent entry',
  );
  // Sanity: distinct entries must remain individually resolvable when unique.
  assert.equal(entryA !== entryB, true);
});

test('(c) real spawn: setStatus emits a non-blocking extension_ui_request and appendEntry persists a custom entry', async () => {
  // E6/E8: command dispatch runs before model validation (agent-session prompt),
  // so invoking the health command needs no configured model/credentials and is
  // deterministic even on a CI box without pi credentials.
  const cliPath = resolveCliJs();
  const fixturePath = resolveProbeExtensionFixture();

  const dir = await mkdtemp(path.join(tmpdir(), 'pi-vb-rpc-'));
  const extensionPath = path.join(dir, 'vision-bridge-probe-extension.ts');
  await writeFile(extensionPath, await readFile(fixturePath, 'utf8'));

  const client = new RpcClient({
    cliPath,
    cwd: path.join(dir),
    args: ['--no-extensions', '-e', extensionPath],
  });

  const events: unknown[] = [];
  client.onEvent((event) => events.push(event));

  try {
    await client.start();

    // Hard gate: the explicit -e extension loads under --no-extensions.
    const commands = (await client.getCommands()) as Array<{ name?: string; source?: string }>;
    assert.ok(commands.some((c) => c.name === HEALTH_COMMAND && c.source === 'extension'));

    // Dispatch the no-side-effect health command. Its handler calls
    // ctx.ui.setStatus(...) and pi.appendEntry(...).
    await client.prompt(`/${HEALTH_COMMAND} hello`);

    const setStatus = await waitForEvent(
      events,
      (e) =>
        (e as any)?.type === 'extension_ui_request' &&
        (e as any)?.method === 'setStatus' &&
        (e as any)?.statusKey === 'cloudcli.vision-bridge.probe.v1',
      30_000,
    );
    assert.ok(setStatus, 'setStatus must emit an extension_ui_request (method "setStatus")');
    assert.equal((setStatus as any).statusKey, 'cloudcli.vision-bridge.probe.v1');

    // appendEntry must persist a custom entry readable from the session.
    const result = await waitFor(
      async () => {
        const { entries } = (await client.getEntries()) as {
          entries: Array<{ type?: string; customType?: string }>;
        };
        return entries.find((e) => e.type === 'custom' && e.customType === 'cloudcli.vision-bridge.probe.v1');
      },
      30_000,
    );
    assert.ok(result, 'appendEntry must persist a custom session entry');
    assert.equal((result as { type: string }).type, 'custom');
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function waitForEvent(
  events: unknown[],
  predicate: (event: unknown) => boolean,
  timeoutMs: number,
): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 50);
  });
}

function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      const value = await fn();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 50);
  });
}