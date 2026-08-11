/**
 * OpenCode characterization baseline (task 1.1 / R15).
 *
 * Seams used — all already present in production code:
 * - `OpenCodeSessionsProvider.normalizeMessage` — invoked by the runtime as
 *   `context.normalizeMessage` (`opencode-runtime.provider.js:234`).
 * - `OpenCodeSessionsProvider.fetchHistory` — driven against a throwaway SQLite
 *   database by pointing the home directory at a temp folder, which is what
 *   `getOpenCodeDatabasePath()` resolves against. No CLI is involved.
 * - `opencodeRuntime.run(..., context)` — the injected `ProviderRuntimeContext`.
 *   `resolveResumeModel` is awaited before `spawn`, so a rejection records the
 *   pre-spawn failure path with no child process.
 * - `opencodeRuntime.abort(sessionId)`.
 * - `createProviderTokenUsageService(deps)` with an injected database path.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { OpenCodeTokenUsageProvider } from '@/modules/providers/list/opencode/opencode-token-usage.provider.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';

import {
  assertGolden,
  createRecordingWriter,
  createRuntimeContextDouble,
  toEventSpine,
} from './characterization.harness.js';

const SESSION_ID = 'app-session-opencode';
const NATIVE_SESSION_ID = 'native-opencode-1';
const sessions = new OpenCodeSessionsProvider();

/** `opencode run --format json` stdout events for one turn. */
const LIVE_NATIVE_EVENTS = [
  { type: 'text', sessionID: NATIVE_SESSION_ID, id: 'live-user-1', role: 'user', text: 'Show me the README' },
  { type: 'reasoning', sessionID: NATIVE_SESSION_ID, id: 'live-reasoning-1', text: 'Plan the read.' },
  {
    type: 'tool_use',
    sessionID: NATIVE_SESSION_ID,
    id: 'live-tool-1',
    callID: 'call_1',
    tool: 'read',
    input: { filePath: 'README.md' },
    output: '# Title',
  },
  { type: 'text', sessionID: NATIVE_SESSION_ID, id: 'live-text-1', text: 'Here is what I found.' },
  { type: 'step_finish', sessionID: NATIVE_SESSION_ID, id: 'live-step-1' },
];

/**
 * Builds the throwaway OpenCode database at the location the provider derives
 * from the home directory, and returns the temp home to restore afterwards.
 */
async function createOpenCodeDatabase(temporaryHome: string): Promise<string> {
  const databaseDirectory = path.join(temporaryHome, '.local', 'share', 'opencode');
  await mkdir(databaseDirectory, { recursive: true });
  const databasePath = path.join(databaseDirectory, 'opencode.db');

  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      tokens_cache_write INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
  `);

  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)')
    .run(NATIVE_SESSION_ID, 120, 64, 8, 40, 4);

  const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');

  insertMessage.run('msg-1', NATIVE_SESSION_ID, 1_767_322_800_000, JSON.stringify({ role: 'user' }));
  insertPart.run(
    'part-1',
    'msg-1',
    NATIVE_SESSION_ID,
    1_767_322_800_000,
    JSON.stringify({ type: 'text', text: 'Show me the README' }),
  );

  insertMessage.run('msg-2', NATIVE_SESSION_ID, 1_767_322_801_000, JSON.stringify({ role: 'assistant' }));
  insertPart.run(
    'part-2',
    'msg-2',
    NATIVE_SESSION_ID,
    1_767_322_801_000,
    JSON.stringify({ type: 'reasoning', text: 'Plan the read.' }),
  );
  insertPart.run(
    'part-3',
    'msg-2',
    NATIVE_SESSION_ID,
    1_767_322_802_000,
    JSON.stringify({
      type: 'tool',
      tool: 'read',
      callID: 'call_1',
      state: { status: 'completed', input: { filePath: 'README.md' }, output: '# Title' },
    }),
  );
  insertPart.run(
    'part-4',
    'msg-2',
    NATIVE_SESSION_ID,
    1_767_322_803_000,
    JSON.stringify({ type: 'text', text: 'Here is what I found.' }),
  );
  database.close();

  return databasePath;
}

/**
 * `getOpenCodeDatabasePath()` reads `os.homedir()` on every call, so pointing
 * HOME at a temp folder is enough to isolate history reads from real data.
 */
async function withTemporaryHome<T>(run: (temporaryHome: string) => Promise<T>): Promise<T> {
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'characterization-opencode-home-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = temporaryHome;
  process.env.USERPROFILE = temporaryHome;

  try {
    return await run(temporaryHome);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

test('opencode characterization: live event normalization', () => {
  const normalized = LIVE_NATIVE_EVENTS.flatMap(
    (event) => sessions.normalizeMessage(event, SESSION_ID),
  );

  assertGolden('opencode.live', normalized);
});

test('opencode characterization: history resolves by the provider-native id', async () => {
  await withTemporaryHome(async (temporaryHome) => {
    await createOpenCodeDatabase(temporaryHome);

    const byNativeId = await sessions.fetchHistory(SESSION_ID, {
      providerSessionId: NATIVE_SESSION_ID,
    });
    // Without the resume hint the app id is used verbatim and finds nothing.
    const byAppId = await sessions.fetchHistory(SESSION_ID);

    assertGolden('opencode.history', byNativeId);
    assertGolden('opencode.resume', {
      resumedWithNativeId: byNativeId.total,
      resolvedWithAppIdOnly: byAppId.total,
    });
  });
});

test('opencode characterization: replay parity between live and persisted history', async () => {
  await withTemporaryHome(async (temporaryHome) => {
    await createOpenCodeDatabase(temporaryHome);

    const live = LIVE_NATIVE_EVENTS.flatMap((event) => sessions.normalizeMessage(event, SESSION_ID));
    const history = await sessions.fetchHistory(SESSION_ID, {
      providerSessionId: NATIVE_SESSION_ID,
    });

    assertGolden('opencode.replay', {
      live: toEventSpine(live),
      history: toEventSpine(history.messages),
    });
  });
});

test('opencode characterization: runtime failure before spawn', async () => {
  const { events, boundSessionIds, writer } = createRecordingWriter();

  await assert.rejects(
    opencodeRuntime.run(
      'Show me the README',
      { sessionId: SESSION_ID },
      writer,
      createRuntimeContextDouble({
        resolveProviderSessionId: () => NATIVE_SESSION_ID,
        // Rejects before `spawn`: no child process, no network.
        resolveResumeModel: async () => {
          throw new Error('model lookup failed');
        },
      }),
    ),
    /model lookup failed/,
  );

  // Recorded as-is: this path emits no terminal `complete` today.
  assertGolden('opencode.runtime-failure-terminal', {
    runRejected: true,
    events,
    boundSessionIds,
  });
});

test('opencode characterization: abort of an unknown session', async () => {
  assert.equal(await opencodeRuntime.abort('session-that-never-ran'), false);
  assertGolden('opencode.abort', { abortUnknownSession: false });
});

test('opencode characterization: token usage snapshot', async () => {
  await withTemporaryHome(async (temporaryHome) => {
    const databasePath = await createOpenCodeDatabase(temporaryHome);

    const service = createProviderTokenUsageService({
      getSessionById: () => ({
        session_id: SESSION_ID,
        provider: 'opencode',
        provider_session_id: NATIVE_SESSION_ID,
        jsonl_path: null,
        project_path: null,
      }) as never,
      requireUsageFacet: () => new OpenCodeTokenUsageProvider({
        getDatabasePath: () => databasePath,
      }),
    });

    assertGolden('opencode.usage', await service.getSessionTokenUsage(SESSION_ID));
  });
});
