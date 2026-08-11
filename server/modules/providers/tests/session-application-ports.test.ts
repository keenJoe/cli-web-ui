import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureSessionChangePublisher,
  createInMemorySessionChangePublisher,
  sessionChangePublisher,
} from '@/modules/providers/services/session-change-publisher.service.js';
import {
  configureSessionRunStateReader,
  createInMemorySessionRunStateReader,
  sessionRunStateReader,
} from '@/modules/providers/services/session-run-state-reader.service.js';

const sessionUpserted = {
  kind: 'session_upserted' as const,
  sessionId: 'app-session-1',
  provider: 'pi' as const,
  session: {
    id: 'app-session-1',
    summary: 'Port contract',
    messageCount: 0,
    lastActivity: '2026-08-05T10:00:00.000Z',
  },
  project: {
    projectId: 'project-1',
    path: '/tmp/project-1',
    fullPath: '/tmp/project-1',
    displayName: 'project-1',
    isStarred: false,
  },
  timestamp: '2026-08-05T10:00:00.000Z',
};

test('in-memory session change publisher records structured application events', () => {
  const publisher = createInMemorySessionChangePublisher();

  publisher.publishSessionUpserted(sessionUpserted);

  assert.deepEqual(publisher.events, [sessionUpserted]);
});

test('configured session change publisher delegates and can restore the previous adapter', () => {
  const first = createInMemorySessionChangePublisher();
  const second = createInMemorySessionChangePublisher();
  const restoreFirst = configureSessionChangePublisher(first);

  try {
    sessionChangePublisher.publishSessionUpserted(sessionUpserted);
    const restoreSecond = configureSessionChangePublisher(second);
    try {
      sessionChangePublisher.publishSessionUpserted(sessionUpserted);
    } finally {
      restoreSecond();
    }
    sessionChangePublisher.publishSessionUpserted(sessionUpserted);
  } finally {
    restoreFirst();
  }

  assert.equal(first.events.length, 2);
  assert.equal(second.events.length, 1);
});

test('in-memory run-state reader isolates the sessions service from transport state', () => {
  const runningSessions = [{
    sessionId: 'app-session-1',
    provider: 'pi' as const,
    startedAt: 123,
    lastSeq: 4,
  }];
  const first = createInMemorySessionRunStateReader(runningSessions);
  const second = createInMemorySessionRunStateReader([]);
  const restoreFirst = configureSessionRunStateReader(first);

  try {
    assert.deepEqual(sessionRunStateReader.listRunningSessions(), runningSessions);
    const restoreSecond = configureSessionRunStateReader(second);
    try {
      assert.deepEqual(sessionRunStateReader.listRunningSessions(), []);
    } finally {
      restoreSecond();
    }
    assert.deepEqual(sessionRunStateReader.listRunningSessions(), runningSessions);
  } finally {
    restoreFirst();
  }
});
