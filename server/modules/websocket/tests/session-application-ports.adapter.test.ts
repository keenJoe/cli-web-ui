import assert from 'node:assert/strict';
import test from 'node:test';

import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  webSocketSessionChangePublisher,
  webSocketSessionRunStateReader,
} from '@/modules/websocket/services/session-application-ports.adapter.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readonly frames: Array<Record<string, unknown>> = [];

  constructor(readonly readyState: number) {}

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test.afterEach(() => {
  connectedClients.clear();
  chatRunRegistry.clearAll();
});

test('WebSocket session-change adapter broadcasts structured events only to open clients', () => {
  const openClient = new FakeConnection(WS_OPEN_STATE);
  const closedClient = new FakeConnection(3);
  connectedClients.add(openClient as never);
  connectedClients.add(closedClient as never);

  webSocketSessionChangePublisher.publishSessionUpserted({
    kind: 'session_upserted',
    sessionId: 'app-session-1',
    provider: 'pi',
    session: {
      id: 'app-session-1',
      summary: 'Production adapter',
      messageCount: 0,
      lastActivity: '2026-08-05T10:00:00.000Z',
    },
    project: null,
    timestamp: '2026-08-05T10:00:00.000Z',
  });

  assert.deepEqual(openClient.frames, [{
    kind: 'session_upserted',
    sessionId: 'app-session-1',
    provider: 'pi',
    session: {
      id: 'app-session-1',
      summary: 'Production adapter',
      messageCount: 0,
      lastActivity: '2026-08-05T10:00:00.000Z',
    },
    project: null,
    timestamp: '2026-08-05T10:00:00.000Z',
  }]);
  assert.deepEqual(closedClient.frames, []);
});

test('WebSocket run-state adapter exposes only running app sessions', () => {
  const connection = new FakeConnection(WS_OPEN_STATE);
  chatRunRegistry.startRun({
    appSessionId: 'app-session-2',
    provider: 'codex',
    providerSessionId: null,
    connection,
    userId: null,
  });

  const runningSessions = webSocketSessionRunStateReader.listRunningSessions();
  assert.equal(runningSessions.length, 1);
  assert.equal(runningSessions[0]?.sessionId, 'app-session-2');
  assert.equal(runningSessions[0]?.provider, 'codex');
  assert.equal(typeof runningSessions[0]?.startedAt, 'number');
  assert.equal(runningSessions[0]?.lastSeq, 0);
});
