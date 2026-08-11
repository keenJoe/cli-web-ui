import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Characterization baseline for "exactly one terminal event per run" on the
 * **WebSocket** transport (task 1.2, evaluation items R10 / R11 / R12).
 *
 * This was recorded before `ProviderRunCoordinator` existed because the
 * registry already implemented first-wins terminal-event de-duplication.
 * Production now receives its normal terminal from the coordinator; these
 * direct registry injections remain a regression anchor for the compatibility
 * safety net, not a description of the current control flow.
 *
 * The counterpart baseline for HTTP/SSE lives in
 * `server/modules/agent/tests/single-terminal-event.baseline.test.ts` and
 * records the historical RED evidence and the coordinator-backed SSE contract.
 *
 * No real provider CLI is involved: the runtime is faked by calling the
 * registry writer exactly the way `chat-websocket.service.ts` drives it.
 */

/** Minimal websocket stand-in that records every outbound JSON frame. */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ws-terminal-baseline-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase([]);

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Terminal events are the `complete` frames the client sees for one run. */
function terminalFrames(connection: FakeConnection): Array<Record<string, unknown>> {
  return connection.frames.filter((frame) => frame.kind === 'complete');
}

test('BASELINE [WS / R10 / 现状即正确] a normal run produces exactly one terminal event', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('ws-normal', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'ws-normal',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    // Simulate the coordinator-projected content and terminal at the registry boundary.
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native-1', content: 'hi' });
    run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0 });

    // A delayed gateway safety fallback must not add a second terminal.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });

    const terminals = terminalFrames(connection);
    assert.equal(terminals.length, 1, 'WS normal run: exactly one terminal event');
    assert.equal(terminals[0]?.exitCode, 0);
    assert.equal(terminals[0]?.actualSessionId, 'ws-normal');
    assert.equal(chatRunRegistry.isProcessing('ws-normal'), false);
  });
});

test('BASELINE [WS / R11 / 现状即正确] abort racing a late runtime complete yields exactly one aborted terminal', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('ws-abort', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'ws-abort',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'codex', sessionId: 'native-2', content: 'partial' });

    // Simulate the coordinator's aborted terminal at the registry boundary.
    chatRunRegistry.completeRun('ws-abort', { exitCode: 0, aborted: true });

    // Inject legacy/delayed duplicate attempts. Both are dropped by the
    // first-wins compatibility rule in `decorateAndRecordEvent`.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-2', exitCode: 1 });
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });

    const terminals = terminalFrames(connection);
    assert.equal(terminals.length, 1, 'WS abort race: exactly one terminal event');
    assert.equal(terminals[0]?.aborted, true);
  });
});

test('BASELINE [WS / R12 / 现状即正确] a runtime that dies without completing yields exactly one failure terminal', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('ws-crash', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'ws-crash',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    // Simulate a non-terminal runtime error followed by the gateway safety fallback.
    run.writer.send({ kind: 'error', provider: 'opencode', sessionId: 'native-3', content: 'spawn failed' });
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });

    // A late legacy duplicate cannot add a second terminal.
    run.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native-3', exitCode: 1 });

    const terminals = terminalFrames(connection);
    assert.equal(terminals.length, 1, 'WS runtime failure: exactly one terminal event');
    assert.equal(terminals[0]?.exitCode, 1);
    assert.equal(terminals[0]?.success, false);
    assert.equal(chatRunRegistry.isProcessing('ws-crash'), false);
  });
});
