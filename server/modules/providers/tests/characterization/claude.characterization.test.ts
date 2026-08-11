/**
 * Claude characterization baseline (task 1.1 / R15).
 *
 * Seams used — all already present in production code, nothing was added:
 * - `ClaudeSessionsProvider.normalizeMessage` — the exact function the runtime
 *   invokes as `context.normalizeMessage` (`claude-runtime.provider.js:680`).
 * - `claudeRuntime.run(..., context)` — the injected `ProviderRuntimeContext`.
 *   Rejecting `resolveResumeModel` reaches the runtime's failure terminal
 *   without constructing an SDK query, so no process is spawned. The same
 *   rejection is what makes the `resume` scenario observable: the runtime
 *   resolves the provider-native id *before* the SDK query is built.
 * - `ClaudeSessionsProvider.fetchHistory` — driven against a throwaway sessions
 *   database (`DATABASE_PATH`) whose row points at a temp JSONL transcript.
 * - `claudeRuntime.abort(sessionId)` — public abort entry point.
 * - `createProviderTokenUsageService(deps)` — injected filesystem/session deps.
 *
 * See `README.md` for the scenarios that are not reachable without editing
 * production code.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { ClaudeTokenUsageProvider } from '@/modules/providers/list/claude/claude-token-usage.provider.js';
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

const SESSION_ID = 'app-session-claude';
const NATIVE_SESSION_ID = 'native-claude-1';
const sessions = new ClaudeSessionsProvider();

/** One assistant turn as the Claude Agent SDK streams it during a live run. */
const LIVE_NATIVE_EVENTS = [
  { type: 'system', subtype: 'init', session_id: 'native-claude-1' },
  { type: 'content_block_delta', delta: { text: 'Reading the file' } },
  {
    uuid: 'live-assistant-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    session_id: 'native-claude-1',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The user wants the README.' },
        { type: 'text', text: 'Here is what I found.' },
        { type: 'tool_use', id: 'toolu_live_1', name: 'Read', input: { file_path: '/repo/README.md' } },
      ],
    },
  },
  {
    uuid: 'live-user-1',
    timestamp: '2026-01-02T03:04:06.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_live_1', content: '# Title', is_error: false }],
    },
  },
  { type: 'content_block_stop' },
];

/** The same turn as it is persisted in `~/.claude/projects/**.jsonl`. */
const HISTORY_NATIVE_ENTRIES = [
  {
    uuid: 'hist-user-1',
    timestamp: '2026-01-02T03:04:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Show me the README' }] },
  },
  {
    uuid: 'hist-meta-1',
    timestamp: '2026-01-02T03:04:01.000Z',
    isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: 'injected skill body' }] },
  },
  {
    uuid: 'hist-assistant-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The user wants the README.' },
        { type: 'text', text: 'Here is what I found.' },
        { type: 'tool_use', id: 'toolu_live_1', name: 'Read', input: { file_path: '/repo/README.md' } },
      ],
    },
  },
  {
    uuid: 'hist-user-2',
    timestamp: '2026-01-02T03:04:06.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_live_1', content: '# Title', is_error: false }],
    },
  },
];

test('claude characterization: live event normalization', () => {
  const normalized = LIVE_NATIVE_EVENTS.flatMap(
    (event) => sessions.normalizeMessage(event, SESSION_ID),
  );

  assertGolden('claude.live', normalized);
});

test('claude characterization: history normalization', () => {
  const normalized = HISTORY_NATIVE_ENTRIES.flatMap(
    (entry) => sessions.normalizeMessage(entry, SESSION_ID),
  );

  assertGolden('claude.history', normalized);
});

test('claude characterization: replay parity between live and persisted history', () => {
  const live = LIVE_NATIVE_EVENTS.flatMap((event) => sessions.normalizeMessage(event, SESSION_ID));
  const history = HISTORY_NATIVE_ENTRIES.flatMap(
    (entry) => sessions.normalizeMessage(entry, SESSION_ID),
  );

  assertGolden('claude.replay', {
    live: toEventSpine(live),
    history: toEventSpine(history),
  });
});

test('claude characterization: fetchHistory reads the session row transcript', async () => {
  await withIsolatedSessionsDatabase(async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'characterization-claude-history-'));
    const transcriptPath = path.join(temporaryDirectory, `${NATIVE_SESSION_ID}.jsonl`);

    try {
      // The reader keeps only the rows whose `sessionId` matches the
      // provider-native id, so the fixture carries it on every entry.
      await writeFile(transcriptPath, HISTORY_NATIVE_ENTRIES
        .map((entry) => JSON.stringify({ ...entry, sessionId: NATIVE_SESSION_ID }))
        .join('\n'));

      sessionsDb.createSession(
        SESSION_ID,
        'claude',
        '/repo',
        'Characterization',
        undefined,
        undefined,
        transcriptPath,
      );

      assertGolden(
        'claude.fetchHistory',
        await sessions.fetchHistory(SESSION_ID, { providerSessionId: NATIVE_SESSION_ID }),
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

test('claude characterization: runtime failure terminal', async () => {
  const { events, boundSessionIds, writer } = createRecordingWriter();

  await claudeRuntime.run(
    'Show me the README',
    { sessionId: SESSION_ID },
    writer,
    createRuntimeContextDouble({
      resolveProviderSessionId: () => NATIVE_SESSION_ID,
      // Fails before the SDK query is constructed: no subprocess, no network.
      resolveResumeModel: async () => {
        throw new Error('model lookup failed');
      },
      isProviderInstalled: async () => true,
      normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    }),
  );

  assertGolden('claude.runtime-failure-terminal', { events, boundSessionIds });
});

test('claude characterization: resume resolves the native session id before the SDK query', async () => {
  const { events, boundSessionIds, writer } = createRecordingWriter();
  const contextCalls = createContextCallLog();

  await claudeRuntime.run(
    'And the CHANGELOG?',
    { sessionId: SESSION_ID, cwd: '/repo', model: 'sonnet' },
    writer,
    createRuntimeContextDouble({
      resolveProviderSessionId: contextCalls.record(
        'resolveProviderSessionId',
        () => NATIVE_SESSION_ID,
      ),
      // Stops the run before `query()` is constructed, which is *after* the
      // resume id has been resolved: no SDK, no subprocess.
      resolveResumeModel: contextCalls.record('resolveResumeModel', async () => {
        throw new Error('model lookup failed');
      }),
      normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    }),
  );

  assertGolden('claude.resume', {
    contextCalls: contextCalls.calls,
    events,
    boundSessionIds,
    // A resumed run must not re-announce the session to the client.
    sessionCreatedEvents: events.filter(
      (event) => (event as { kind?: string }).kind === 'session_created',
    ).length,
  });
});

test('claude characterization: abort of an unknown session', async () => {
  assert.equal(await claudeRuntime.abort('session-that-never-ran'), false);
  assertGolden('claude.abort', { abortUnknownSession: false });
});

test('claude characterization: token usage snapshot', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'characterization-claude-usage-'));
  const sessionFilePath = path.join(temporaryDirectory, 'native-claude-1.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 2 } } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 120,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 8,
            output_tokens: 64,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => ({
        session_id: SESSION_ID,
        provider: 'claude',
        provider_session_id: 'native-claude-1',
        jsonl_path: sessionFilePath,
        project_path: null,
      }) as never,
      requireUsageFacet: () => new ClaudeTokenUsageProvider({
        getContextWindow: () => '160000',
      }),
    });

    assertGolden('claude.usage', await service.getSessionTokenUsage(SESSION_ID));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
