/**
 * Codex characterization baseline (task 1.1 / R15).
 *
 * Seams used — all already present in production code:
 * - `CodexSessionsProvider.normalizeMessage` — invoked by the runtime as
 *   `context.normalizeMessage` (`codex-runtime.provider.js:348`). Live events
 *   reach it *after* the module-private `transformCodexEvent`, so the fixtures
 *   below are authored in that transformed shape.
 * - `codexRuntime.run(..., context)` — the injected `ProviderRuntimeContext`.
 *   `resolveResumeModel` is awaited before any SDK thread is created, so a
 *   rejection characterizes the pre-stream failure path without a subprocess.
 *   The same rejection makes `resume` observable: `resolveProviderSessionId`
 *   runs before `new Codex()`.
 * - `CodexSessionsProvider.fetchHistory` — driven against a throwaway sessions
 *   database (`DATABASE_PATH`) whose row points at a temp rollout JSONL.
 * - `codexRuntime.abort(sessionId)`.
 * - `createProviderTokenUsageService(deps)`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { CodexTokenUsageProvider } from '@/modules/providers/list/codex/codex-token-usage.provider.js';
import { sessionsDb } from '@/modules/database/index.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';

import {
  assertGolden,
  createContextCallLog,
  createRecordingWriter,
  createRuntimeContextDouble,
  toEventSpine,
  withIsolatedSessionsDatabase,
} from './characterization.harness.js';

const SESSION_ID = 'app-session-codex';
const NATIVE_SESSION_ID = 'native-codex-1';
const sessions = new CodexSessionsProvider();

/** One assistant turn, in the shape `transformCodexEvent` hands the normalizer. */
const LIVE_TRANSFORMED_EVENTS = [
  { type: 'thread_started', threadId: 'native-codex-1' },
  { type: 'item', itemType: 'reasoning', message: { role: 'assistant', content: 'Plan the edit.', isReasoning: true } },
  { type: 'item', itemType: 'agent_message', message: { role: 'assistant', content: 'Here is what I found.' } },
  {
    type: 'item',
    itemType: 'command_execution',
    command: 'cat README.md',
    output: '# Title',
    exitCode: 0,
    status: 'completed',
  },
  { type: 'turn_complete', usage: { input_tokens: 120, output_tokens: 64, total_tokens: 184 } },
];

/** The same turn as persisted Codex history entries. */
const HISTORY_NATIVE_ENTRIES = [
  {
    uuid: 'hist-codex-user-1',
    timestamp: '2026-01-02T03:04:00.000Z',
    message: { role: 'user', content: 'Show me the README' },
  },
  {
    uuid: 'hist-codex-thinking-1',
    timestamp: '2026-01-02T03:04:01.000Z',
    type: 'thinking',
    message: { role: 'assistant', content: 'Plan the edit.' },
  },
  {
    uuid: 'hist-codex-assistant-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    message: { role: 'assistant', content: 'Here is what I found.' },
  },
  {
    uuid: 'hist-codex-tool-1',
    timestamp: '2026-01-02T03:04:06.000Z',
    type: 'tool_use',
    toolName: 'Bash',
    toolCallId: 'call_1',
    toolInput: { command: 'cat README.md' },
  },
  {
    uuid: 'hist-codex-tool-result-1',
    timestamp: '2026-01-02T03:04:07.000Z',
    type: 'tool_result',
    toolCallId: 'call_1',
    output: '# Title',
  },
];

/**
 * The same turn as raw rollout JSONL lines, i.e. what `fetchHistory` parses
 * before `normalizeHistoryEntry` sees it.
 */
const HISTORY_ROLLOUT_LINES = [
  {
    type: 'event_msg',
    timestamp: '2026-01-02T03:04:00.000Z',
    payload: { type: 'user_message', kind: 'plain', message: 'Show me the README' },
  },
  {
    type: 'response_item',
    timestamp: '2026-01-02T03:04:01.000Z',
    payload: { type: 'reasoning', summary: [{ text: 'Plan the edit.' }] },
  },
  {
    type: 'response_item',
    timestamp: '2026-01-02T03:04:05.000Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here is what I found.' }] },
  },
  {
    type: 'response_item',
    timestamp: '2026-01-02T03:04:06.000Z',
    payload: {
      type: 'function_call',
      name: 'shell_command',
      arguments: JSON.stringify({ command: 'cat README.md' }),
      call_id: 'call_1',
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-01-02T03:04:07.000Z',
    payload: { type: 'function_call_output', call_id: 'call_1', output: '# Title' },
  },
  {
    type: 'event_msg',
    timestamp: '2026-01-02T03:04:08.000Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 120, output_tokens: 64, total_tokens: 184 },
        model_context_window: 272_000,
      },
    },
  },
];

test('codex characterization: live event normalization', () => {
  const normalized = LIVE_TRANSFORMED_EVENTS.flatMap(
    (event) => sessions.normalizeMessage(event, SESSION_ID),
  );

  assertGolden('codex.live', normalized);
});

test('codex characterization: history normalization', () => {
  const normalized = HISTORY_NATIVE_ENTRIES.flatMap(
    (entry) => sessions.normalizeMessage(entry, SESSION_ID),
  );

  assertGolden('codex.history', normalized);
});

test('codex characterization: replay parity between live and persisted history', () => {
  const live = LIVE_TRANSFORMED_EVENTS.flatMap(
    (event) => sessions.normalizeMessage(event, SESSION_ID),
  );
  const history = HISTORY_NATIVE_ENTRIES.flatMap(
    (entry) => sessions.normalizeMessage(entry, SESSION_ID),
  );

  assertGolden('codex.replay', {
    live: toEventSpine(live),
    history: toEventSpine(history),
  });
});

test('codex characterization: fetchHistory reads the session row rollout file', async () => {
  await withIsolatedSessionsDatabase(async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'characterization-codex-history-'));
    const rolloutPath = path.join(temporaryDirectory, `rollout-${NATIVE_SESSION_ID}.jsonl`);

    try {
      await writeFile(rolloutPath, HISTORY_ROLLOUT_LINES.map((line) => JSON.stringify(line)).join('\n'));

      sessionsDb.createSession(
        SESSION_ID,
        'codex',
        '/repo',
        'Characterization',
        undefined,
        undefined,
        rolloutPath,
      );

      assertGolden('codex.fetchHistory', await sessions.fetchHistory(SESSION_ID));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

test('codex characterization: runtime failure before the thread starts', async () => {
  const { events, boundSessionIds, writer } = createRecordingWriter();

  await assert.rejects(
    codexRuntime.run(
      'Show me the README',
      { sessionId: SESSION_ID },
      writer,
      createRuntimeContextDouble({
        resolveProviderSessionId: () => NATIVE_SESSION_ID,
        // Rejects before `new Codex()`: no subprocess, no network.
        resolveResumeModel: async () => {
          throw new Error('model lookup failed');
        },
      }),
    ),
    /model lookup failed/,
  );

  // Recorded as-is: this path emits no terminal `complete` today.
  assertGolden('codex.runtime-failure-terminal', {
    runRejected: true,
    events,
    boundSessionIds,
  });
});

test('codex characterization: resume resolves the native thread id before `new Codex()`', async () => {
  const { events, boundSessionIds, writer } = createRecordingWriter();
  const contextCalls = createContextCallLog();

  await assert.rejects(
    codexRuntime.run(
      'And the CHANGELOG?',
      { sessionId: SESSION_ID, cwd: '/repo', model: 'gpt-5' },
      writer,
      createRuntimeContextDouble({
        resolveProviderSessionId: contextCalls.record(
          'resolveProviderSessionId',
          () => NATIVE_SESSION_ID,
        ),
        // Stops the run after the resume id is resolved but before the SDK
        // thread is constructed (`codex-runtime.provider.js:241` vs `:267`).
        resolveResumeModel: contextCalls.record('resolveResumeModel', async () => {
          throw new Error('model lookup failed');
        }),
      }),
    ),
    /model lookup failed/,
  );

  assertGolden('codex.resume', {
    contextCalls: contextCalls.calls,
    events,
    boundSessionIds,
    // A resumed run must not re-announce the session to the client.
    sessionCreatedEvents: events.filter(
      (event) => (event as { kind?: string }).kind === 'session_created',
    ).length,
  });
});

test('codex characterization: abort of an unknown session', async () => {
  assert.equal(await codexRuntime.abort('session-that-never-ran'), false);
  assertGolden('codex.abort', { abortUnknownSession: false });
});

test('codex characterization: token usage snapshot', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'characterization-codex-usage-'));
  const sessionFilePath = path.join(temporaryDirectory, 'rollout-native-codex-1.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            model_context_window: 200_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 120, output_tokens: 64, total_tokens: 184 },
            model_context_window: 272_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => ({
        session_id: SESSION_ID,
        provider: 'codex',
        provider_session_id: 'native-codex-1',
        jsonl_path: sessionFilePath,
        project_path: null,
      }) as never,
      requireUsageFacet: () => new CodexTokenUsageProvider({
        fileExists: () => true,
      }),
    });

    assertGolden('codex.usage', await service.getSessionTokenUsage(SESSION_ID));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
