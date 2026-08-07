/**
 * Cursor characterization baseline (task 1.1 / R15).
 *
 * Seams used — all already present in production code:
 * - `CursorSessionsProvider.normalizeMessage` — invoked by the runtime as
 *   `context.normalizeMessage` (`cursor-runtime.provider.js:223,250`).
 * - `CursorSessionsProvider.normalizeCursorBlobs` — the history normalizer,
 *   documented in the provider as public "so tests can drive history
 *   normalization with synthetic blobs".
 * - `cursorRuntime.abort(sessionId)`.
 * - `createProviderTokenUsageService(deps)`.
 *
 * Cursor's runtime failure path is deliberately NOT exercised here: see
 * `README.md` — `spawnCursor` awaits inside an async Promise executor, so a
 * rejected `resolveResumeModel` leaves the run promise permanently unsettled.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { cursorRuntime } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError } from '@/shared/utils.js';

import {
  assertGolden,
  createContextCallLog,
  createRecordingWriter,
  createRuntimeContextDouble,
  toEventSpine,
} from './characterization.harness.js';

const SESSION_ID = 'app-session-cursor';
const NATIVE_SESSION_ID = 'native-cursor-1';
const sessions = new CursorSessionsProvider();

/** `cursor-agent --output-format stream-json` NDJSON lines for one turn. */
const LIVE_NATIVE_EVENTS: unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'native-cursor-1', model: 'composer-1', cwd: '/repo' },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Show me the README' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is what ' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I found.' }] } },
  'plain stdout line that is not JSON',
  { type: 'result', subtype: 'success' },
];

/** The same turn as store.db message blobs. */
const HISTORY_NATIVE_BLOBS = [
  {
    id: 'blob-1',
    rowid: 1,
    sequence: 0,
    content: { message: { role: 'user', content: [{ type: 'text', text: 'Show me the README' }] } },
  },
  {
    id: 'blob-2',
    rowid: 2,
    sequence: 1,
    content: { message: { role: 'assistant', content: [{ type: 'text', text: 'Here is what I found.' }] } },
  },
  {
    id: 'blob-3',
    rowid: 3,
    sequence: 2,
    content: { message: { role: 'system', content: 'internal system preamble' } },
  },
];

test('cursor characterization: live event normalization', () => {
  const normalized = LIVE_NATIVE_EVENTS.flatMap(
    (event) => sessions.normalizeMessage(event, SESSION_ID),
  );

  assertGolden('cursor.live', normalized);
});

test('cursor characterization: history normalization', () => {
  const normalized = sessions.normalizeCursorBlobs(HISTORY_NATIVE_BLOBS as never, SESSION_ID);

  assertGolden('cursor.history', normalized);
});

test('cursor characterization: replay parity between live and persisted history', () => {
  const live = LIVE_NATIVE_EVENTS.flatMap((event) => sessions.normalizeMessage(event, SESSION_ID));
  const history = sessions.normalizeCursorBlobs(HISTORY_NATIVE_BLOBS as never, SESSION_ID);

  assertGolden('cursor.replay', {
    live: toEventSpine(live),
    history: toEventSpine(history),
  });
});

test('cursor characterization: resume resolves the native session id before spawn', async () => {
  const { events, boundSessionIds, writer } = createRecordingWriter();
  const contextCalls = createContextCallLog();
  // `resolveProviderSessionId` runs at `cursor-runtime.provider.js:47`, the
  // `--resume=` flag is built at `:69` and `spawnFunction` only fires at `:157`.
  // Suspending `resolveResumeModel` (awaited at `:48`) stops the run in between
  // without spawning and without the unhandled rejection a throw would cause
  // inside the `new Promise(async ...)` executor — see `README.md`.
  const suspendForever = new Promise<undefined>(() => {});

  // The run promise is deliberately never awaited: it cannot settle here.
  void cursorRuntime.run(
    'And the CHANGELOG?',
    { sessionId: SESSION_ID, cwd: '/repo', model: 'composer-1' },
    writer,
    createRuntimeContextDouble({
      resolveProviderSessionId: contextCalls.record(
        'resolveProviderSessionId',
        () => NATIVE_SESSION_ID,
      ),
      resolveResumeModel: contextCalls.record('resolveResumeModel', () => suspendForever),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assertGolden('cursor.resume', {
    contextCalls: contextCalls.calls,
    events,
    boundSessionIds,
    // A resumed run must not re-announce the session to the client.
    sessionCreatedEvents: events.filter(
      (event) => (event as { kind?: string }).kind === 'session_created',
    ).length,
  });
});

test('cursor characterization: abort of an unknown session', async () => {
  assert.equal(await cursorRuntime.abort('session-that-never-ran'), false);
  assertGolden('cursor.abort', { abortUnknownSession: false });
});

test('cursor characterization: token usage snapshot', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => ({
      session_id: SESSION_ID,
      provider: 'cursor',
      provider_session_id: 'native-cursor-1',
      jsonl_path: null,
      project_path: null,
    }) as never,
  });

  let observedError: { errorCode: string; statusCode: number } | undefined;
  await assert.rejects(
    () => service.getSessionTokenUsage(SESSION_ID),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROVIDER_CAPABILITY_UNSUPPORTED');
      assert.equal(error.statusCode, 400);
      observedError = { errorCode: error.code, statusCode: error.statusCode };
      return true;
    },
  );

  assertGolden('cursor.usage', observedError);
});
