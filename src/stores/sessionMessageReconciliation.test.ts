import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import type { NormalizedMessage, SessionStore } from './useSessionStore';
import {
  createSessionMessageReconciliationState,
  mergeSessionMessages,
  pruneRealtimeSupersededByServer,
  reconcileSessionMessages,
  removeOptimisticUserEchoes,
  upsertRealtimeMessages,
} from './sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

const renderSessionStore = async (): Promise<SessionStore> => {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    const storeModule = await vite.ssrLoadModule('/src/stores/useSessionStore.ts');
    const useSessionStore = storeModule.useSessionStore as () => SessionStore;
    let sessionStore: SessionStore | undefined;
    function SessionStoreProbe() {
      sessionStore = useSessionStore();
      return null;
    }
    renderToStaticMarkup(createElement(SessionStoreProbe));
    assert.ok(sessionStore);
    return sessionStore;
  } finally {
    await vite.close();
  }
};

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('replaces repeated realtime snapshots with the same logical message id', () => {
  const base = createUserMessage('thinking-1', '2026-08-04T00:00:00.000Z', {
    provider: 'pi',
    kind: 'thinking',
    role: 'assistant',
    content: 'The',
    isStreaming: true,
    seq: 1,
  });
  const updated = {
    ...base,
    content: 'The answer',
    seq: 2,
  };
  const finalized = {
    ...updated,
    content: 'The authoritative answer',
    isStreaming: false,
    duration: 2,
    seq: 3,
  };

  const messages = upsertRealtimeMessages([], [base, updated, finalized]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, 'thinking-1');
  assert.equal(messages[0]?.content, 'The authoritative answer');
  assert.equal(messages[0]?.isStreaming, false);
  assert.equal(messages[0]?.duration, 2);
});

test('ignores an older sequenced snapshot for an existing realtime message', () => {
  const finalized = createUserMessage('thinking-1', '2026-08-04T00:00:00.000Z', {
    provider: 'pi',
    kind: 'thinking',
    role: 'assistant',
    content: 'complete',
    isStreaming: false,
    seq: 9,
  });
  const stale = {
    ...finalized,
    content: 'partial',
    isStreaming: true,
    seq: 8,
  };

  assert.deepEqual(upsertRealtimeMessages([finalized], [stale]), [finalized]);
});

test('shows one Pi user, thinking, and assistant row after persisted history catches up', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.500Z', {
      provider: 'pi',
      content: 'Explain the result',
    }),
    createUserMessage('persisted-thinking', '2026-08-06T00:00:01.500Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'I should inspect the result.',
      isStreaming: false,
    }),
    createUserMessage('persisted-assistant', '2026-08-06T00:00:02.500Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'The result is valid.',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_pi_user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'Explain the result',
    }),
    createUserMessage('live-thinking', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'I should inspect the result.',
      isStreaming: false,
    }),
    createUserMessage('live-assistant', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'The result is valid.',
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );
  const visibleMessages = [...persistedMessages, ...remainingRealtime];

  assert.deepEqual(
    visibleMessages.map(({ kind, role, content }) => ({ kind, role, content })),
    [
      { kind: 'text', role: 'user', content: 'Explain the result' },
      { kind: 'thinking', role: 'assistant', content: 'I should inspect the result.' },
      { kind: 'text', role: 'assistant', content: 'The result is valid.' },
    ],
  );
});

test('keeps a later realtime turn when its content repeats a completed persisted turn', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('persisted-thinking', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'THINK',
      isStreaming: false,
    }),
    createUserMessage('persisted-assistant', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_pi_user', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('live-thinking', '2026-08-06T00:00:06.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'THINK',
      isStreaming: false,
    }),
    createUserMessage('live-assistant', '2026-08-06T00:00:07.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_pi_user', 'live-thinking', 'live-assistant'],
  );
});

test('preserves an ambiguous realtime turn when message timestamps are invalid', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('persisted-thinking', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'THINK',
      isStreaming: false,
    }),
    createUserMessage('persisted-assistant', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_new', 'also-not-a-timestamp', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('new-thinking', 'also-not-a-timestamp', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'THINK',
      isStreaming: false,
    }),
    createUserMessage('new-answer', 'also-not-a-timestamp', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new', 'new-thinking', 'new-answer'],
  );
});

test('preserves a new realtime turn when server clock skew makes an old turn arrive later', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('old-thinking', '2026-08-06T00:00:08.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'THINK',
      isStreaming: false,
    }),
    createUserMessage('old-answer', '2026-08-06T00:00:09.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('new-thinking', '2026-08-06T00:00:06.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'THINK',
      isStreaming: false,
    }),
    createUserMessage('new-answer', '2026-08-06T00:00:07.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new', 'new-thinking', 'new-answer'],
  );
});

test('keeps a current answer when its persisted user arrives 300ms later', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first',
    }),
    createUserMessage('old-answer', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
    createUserMessage('current-user', '2026-08-06T00:00:05.500Z', {
      provider: 'pi',
      content: 'second',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('current-answer', '2026-08-06T00:00:05.200Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['current-answer'],
  );
});

test('keeps an unpersisted current answer across sequential refreshes', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first',
    }),
    createUserMessage('old-answer', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
    createUserMessage('current-user', '2026-08-06T00:00:05.500Z', {
      provider: 'pi',
      content: 'second',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('current-answer', '2026-08-06T00:00:05.200Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  const afterFirstRefresh = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
    reconciliationState,
  );
  const afterSecondRefresh = pruneRealtimeSupersededByServer(
    persistedMessages,
    afterFirstRefresh,
    reconciliationState,
  );

  assert.deepEqual(
    afterFirstRefresh.map((message) => message.id),
    ['current-answer'],
  );
  assert.deepEqual(
    afterSecondRefresh.map((message) => message.id),
    ['current-answer'],
  );
});

test('clears a retained current answer when a later snapshot persists it', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedUser = createUserMessage(
    'current-user',
    '2026-08-06T00:00:05.500Z',
    {
      provider: 'pi',
      content: 'second',
    },
  );
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('current-answer', '2026-08-06T00:00:05.200Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];

  const afterUserSnapshot = pruneRealtimeSupersededByServer(
    [persistedUser],
    realtimeMessages,
    reconciliationState,
  );
  const persistedAnswer = createUserMessage(
    'persisted-current-answer',
    '2026-08-06T00:00:06.000Z',
    {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    },
  );
  const afterAnswerSnapshot = pruneRealtimeSupersededByServer(
    [persistedUser, persistedAnswer],
    afterUserSnapshot,
    reconciliationState,
  );

  assert.deepEqual(
    afterUserSnapshot.map((message) => message.id),
    ['current-answer'],
  );
  assert.deepEqual(afterAnswerSnapshot, []);
});

test('propagates retained turn lineage to a newly appended realtime child', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedUser = createUserMessage(
    'current-user',
    '2026-08-06T00:00:05.500Z',
    {
      provider: 'pi',
      content: 'second',
    },
  );
  const initialRealtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('current-answer', '2026-08-06T00:00:05.200Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];
  const retainedRealtime = pruneRealtimeSupersededByServer(
    [persistedUser],
    initialRealtimeMessages,
    reconciliationState,
  );
  const withNewThinking = upsertRealtimeMessages(retainedRealtime, [
    createUserMessage('current-thinking', '2026-08-06T00:00:05.300Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'NEXT',
      isStreaming: false,
    }),
  ], reconciliationState);
  const completedSnapshot: NormalizedMessage[] = [
    persistedUser,
    createUserMessage('persisted-current-answer', '2026-08-06T00:00:06.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
    createUserMessage('persisted-current-thinking', '2026-08-06T00:00:06.100Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'NEXT',
      isStreaming: false,
    }),
  ];

  const afterCompletedSnapshot = pruneRealtimeSupersededByServer(
    completedSnapshot,
    withNewThinking,
    reconciliationState,
  );

  assert.deepEqual(afterCompletedSnapshot, []);
});

test('keeps current thinking when identical text belongs to an older server turn', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first',
    }),
    createUserMessage('old-thinking', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'SAME THINKING',
      isStreaming: false,
    }),
    createUserMessage('current-user', '2026-08-06T00:00:05.500Z', {
      provider: 'pi',
      content: 'second',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('current-thinking', '2026-08-06T00:00:05.200Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'SAME THINKING',
      isStreaming: false,
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['current-thinking'],
  );
});

test('keeps unpersisted current thinking across sequential refreshes', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first',
    }),
    createUserMessage('old-thinking', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'SAME THINKING',
      isStreaming: false,
    }),
    createUserMessage('current-user', '2026-08-06T00:00:05.500Z', {
      provider: 'pi',
      content: 'second',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('current-thinking', '2026-08-06T00:00:05.200Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'SAME THINKING',
      isStreaming: false,
    }),
  ];

  const afterFirstRefresh = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
    reconciliationState,
  );
  const afterSecondRefresh = pruneRealtimeSupersededByServer(
    persistedMessages,
    afterFirstRefresh,
    reconciliationState,
  );

  assert.deepEqual(
    afterFirstRefresh.map((message) => message.id),
    ['current-thinking'],
  );
  assert.deepEqual(
    afterSecondRefresh.map((message) => message.id),
    ['current-thinking'],
  );
});

test('matches identical finalized thinking rows to one server row at most once', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('current-user', '2026-08-06T00:00:05.500Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('persisted-thinking', '2026-08-06T00:00:06.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'SAME THINKING',
      isStreaming: false,
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('current-thinking-1', '2026-08-06T00:00:05.700Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'SAME THINKING',
      isStreaming: false,
    }),
    createUserMessage('current-thinking-2', '2026-08-06T00:00:05.800Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'SAME THINKING',
      isStreaming: false,
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['current-thinking-2'],
  );
});

test('keeps streaming thinking and assistant snapshots visible', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('current-user', '2026-08-06T00:00:05.500Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('persisted-thinking', '2026-08-06T00:00:06.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'PARTIAL THINKING',
      isStreaming: false,
    }),
    createUserMessage('persisted-answer', '2026-08-06T00:00:07.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'PARTIAL ANSWER',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_current', '2026-08-06T00:00:05.000Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('streaming-thinking', '2026-08-06T00:00:05.200Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'PARTIAL THINKING',
      isStreaming: true,
    }),
    createUserMessage('streaming-answer', '2026-08-06T00:00:05.300Z', {
      provider: 'pi',
      kind: 'stream_delta',
      role: 'assistant',
      content: 'PARTIAL ANSWER',
      isStreaming: true,
    }),
  ];

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['streaming-thinking', 'streaming-answer'],
  );
});

test('does not let a completed tool-only turn consume a later same-text optimistic user', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('old-tool-use', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      kind: 'tool_use',
      role: undefined,
      toolId: 'old-tool',
    }),
    createUserMessage('old-tool-result', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      kind: 'tool_result',
      role: undefined,
      toolId: 'old-tool',
    }),
  ];
  const localNew = createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
    provider: 'pi',
    content: 'repeat',
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    persistedMessages,
    [localNew],
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new'],
  );
});

test('does not let a completed error-only turn consume a later same-text optimistic user', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('old-error', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      kind: 'error',
      role: undefined,
      content: 'Provider failed',
      isError: true,
    }),
  ];
  const localNew = createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
    provider: 'pi',
    content: 'repeat',
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    persistedMessages,
    [localNew],
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new'],
  );
});

test('does not let a turn-end status consume a later same-text optimistic user', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('old-turn-end', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      kind: 'status',
      role: undefined,
      status: 'turn_end',
    }),
  ];
  const localNew = createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
    provider: 'pi',
    content: 'repeat',
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    persistedMessages,
    [localNew],
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new'],
  );
});

test('preserves a later same-text optimistic user when an older server user is ambiguous', () => {
  const oldPersistedUser = createUserMessage(
    'old-user',
    '2026-08-06T00:00:00.000Z',
    {
      provider: 'pi',
      content: 'repeat',
    },
  );
  const localNew = createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
    provider: 'pi',
    content: 'repeat',
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [oldPersistedUser],
    [localNew],
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new'],
  );
});

test('preserves one optimistic user when two persisted user candidates are eligible', () => {
  const localUser = createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
    provider: 'pi',
    content: 'repeat',
  });
  const firstCandidate = createUserMessage(
    'candidate-1',
    '2026-08-06T00:00:05.100Z',
    {
      provider: 'pi',
      content: 'repeat',
    },
  );
  const secondCandidate = createUserMessage(
    'candidate-2',
    '2026-08-06T00:00:05.200Z',
    {
      provider: 'pi',
      content: 'repeat',
    },
  );

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstCandidate, secondCandidate],
    [localUser],
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new'],
  );
});

test('renders a current answer when timestamp sorting places it beside an older identical answer', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first',
    }),
    createUserMessage('old-answer', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
    createUserMessage('current-user', '2026-08-06T00:00:05.500Z', {
      provider: 'pi',
      content: 'second',
    }),
  ];
  const retainedCurrentAnswer = createUserMessage(
    'current-answer',
    '2026-08-06T00:00:05.200Z',
    {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    },
  );

  const renderedMessages = mergeSessionMessages(
    persistedMessages,
    [retainedCurrentAnswer],
  );

  assert.deepEqual(
    renderedMessages.map((message) => message.id),
    ['old-user', 'old-answer', 'current-answer', 'current-user'],
  );
});

test('retains active turn lineage after every anchored realtime row reconciles', () => {
  const reconciliationState = {
    activeServerUserId: null as string | null,
    activeMatchedLocalUserTime: null as number | null,
    serverUserIdByRealtimeMessageId: new Map<string, string>(),
    claimedServerMessageIds: new Set<string>(),
    consumedServerMessageIdByRealtimeMessageId: new Map<string, string>(),
  };
  const persistedUser = createUserMessage(
    'persisted-user',
    '2026-08-06T00:00:00.500Z',
    {
      provider: 'pi',
      content: 'prompt',
    },
  );
  const persistedFirst = createUserMessage(
    'persisted-first',
    '2026-08-06T00:00:01.500Z',
    {
      provider: 'pi',
      role: 'assistant',
      content: 'FIRST',
    },
  );
  const afterSnapshotA = pruneRealtimeSupersededByServer(
    [persistedUser, persistedFirst],
    [
      createUserMessage('local_prompt', '2026-08-06T00:00:00.000Z', {
        provider: 'pi',
        content: 'prompt',
      }),
      createUserMessage('live-first', '2026-08-06T00:00:01.000Z', {
        provider: 'pi',
        role: 'assistant',
        content: 'FIRST',
      }),
    ],
    reconciliationState,
  );
  const withSecondAnswer = upsertRealtimeMessages(
    afterSnapshotA,
    [
      createUserMessage('live-second', '2026-08-06T00:00:02.000Z', {
        provider: 'pi',
        role: 'assistant',
        content: 'SECOND',
      }),
    ],
    reconciliationState,
  );
  const persistedSecond = createUserMessage(
    'persisted-second',
    '2026-08-06T00:00:02.500Z',
    {
      provider: 'pi',
      role: 'assistant',
      content: 'SECOND',
    },
  );
  const afterSnapshotB = pruneRealtimeSupersededByServer(
    [persistedUser, persistedFirst, persistedSecond],
    withSecondAnswer,
    reconciliationState,
  );

  assert.deepEqual(afterSnapshotA, []);
  assert.deepEqual(afterSnapshotB, []);

  upsertRealtimeMessages(
    [],
    [
      createUserMessage('local_next', '2026-08-06T00:00:03.000Z', {
        provider: 'pi',
        content: 'next prompt',
      }),
    ],
    reconciliationState,
  );
  assert.equal(reconciliationState.activeServerUserId, null);
});

test('does not match a local user to a server turn with earlier thinking activity', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('server-user', '2026-08-06T00:00:06.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('old-thinking', '2026-08-06T00:00:04.000Z', {
      provider: 'pi',
      kind: 'thinking',
      role: 'assistant',
      content: 'OLD THINKING',
      isStreaming: false,
    }),
  ];
  const localUser = createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
    provider: 'pi',
    content: 'repeat',
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    persistedMessages,
    [localUser],
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new'],
  );
});

test('does not match a local user to a server turn with earlier status activity', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('server-user', '2026-08-06T00:00:06.000Z', {
      provider: 'pi',
      content: 'repeat',
    }),
    createUserMessage('old-status', '2026-08-06T00:00:04.000Z', {
      provider: 'pi',
      kind: 'status',
      role: undefined,
      status: 'retry',
    }),
  ];
  const localUser = createUserMessage('local_new', '2026-08-06T00:00:05.000Z', {
    provider: 'pi',
    content: 'repeat',
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    persistedMessages,
    [localUser],
  );

  assert.deepEqual(
    remainingRealtime.map((message) => message.id),
    ['local_new'],
  );
});

test('renders invalid-timestamp realtime rows after valid persisted history', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'old prompt',
    }),
    createUserMessage('persisted-answer', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'old answer',
    }),
  ];
  const realtimeMessages: NormalizedMessage[] = [
    createUserMessage('local_new', 'invalid', {
      provider: 'pi',
      content: 'new prompt',
    }),
    createUserMessage('live-answer', 'invalid', {
      provider: 'pi',
      role: 'assistant',
      content: 'new answer',
    }),
  ];

  const renderedMessages = mergeSessionMessages(
    persistedMessages,
    realtimeMessages,
  );

  assert.deepEqual(
    renderedMessages.map((message) => message.id),
    ['persisted-user', 'persisted-answer', 'local_new', 'live-answer'],
  );
});

test('store preserves turn lineage through updateStreaming and finalizeStreaming', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'stream-session';
  const slot = sessionStore.getSlot(sessionId);
  slot.reconciliationState.activeServerUserId = 'persisted-user';

  sessionStore.updateStreaming(sessionId, 'DRAFT', 'pi');
  sessionStore.updateStreaming(sessionId, 'FINAL', 'pi');
  sessionStore.finalizeStreaming(sessionId);

  const finalizedMessage = slot.realtimeMessages[0];
  assert.ok(finalizedMessage);
  assert.equal(
    slot.reconciliationState.serverUserIdByRealtimeMessageId.get(finalizedMessage.id),
    'persisted-user',
  );

  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.500Z', {
      provider: 'pi',
      content: 'prompt',
    }),
    createUserMessage('persisted-final', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'FINAL',
    }),
  ];
  const reconciliation = reconcileSessionMessages(
    persistedMessages,
    slot.realtimeMessages,
    slot.reconciliationState,
  );

  assert.deepEqual(reconciliation.realtimeMessages, []);

  const previousState = slot.reconciliationState;
  sessionStore.clearRealtime(sessionId);
  assert.notEqual(slot.reconciliationState, previousState);
  assert.equal(slot.reconciliationState.activeServerUserId, null);
  assert.equal(slot.reconciliationState.serverUserIdByRealtimeMessageId.size, 0);
  assert.equal(slot.reconciliationState.claimedServerMessageIds.size, 0);
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.size,
    0,
  );
});

test('drops an exact websocket replay after its finalized answer already reconciled', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.500Z', {
      provider: 'pi',
      content: 'prompt',
    }),
    createUserMessage('persisted-answer', '2026-08-06T00:00:01.500Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];
  const localUser = createUserMessage('local_prompt', '2026-08-06T00:00:00.000Z', {
    provider: 'pi',
    content: 'prompt',
  });
  const liveAnswer = createUserMessage('live-replay-a', '2026-08-06T00:00:01.000Z', {
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });

  const afterInitialReconciliation = pruneRealtimeSupersededByServer(
    persistedMessages,
    [localUser, liveAnswer],
    reconciliationState,
  );
  const replayedMessages = upsertRealtimeMessages(
    afterInitialReconciliation,
    [liveAnswer],
    reconciliationState,
  );
  const afterReplay = pruneRealtimeSupersededByServer(
    persistedMessages,
    replayedMessages,
    reconciliationState,
  );
  const differentLiveAnswer = createUserMessage(
    'live-replay-b',
    '2026-08-06T00:00:01.100Z',
    {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    },
  );
  const afterDifferentId = pruneRealtimeSupersededByServer(
    persistedMessages,
    upsertRealtimeMessages([], [differentLiveAnswer], reconciliationState),
    reconciliationState,
  );

  assert.deepEqual(afterInitialReconciliation, []);
  assert.deepEqual(afterReplay, []);
  assert.deepEqual(
    afterDifferentId.map((message) => message.id),
    ['live-replay-b'],
  );
});

test('store prunes discarded realtime lineage for append and batch caps', async () => {
  const sessionStore = await renderSessionStore();
  const createAssistantRows = (sessionId: string): NormalizedMessage[] =>
    Array.from({ length: 501 }, (_, index) =>
      createUserMessage(`live-${sessionId}-${index}`, `2026-08-06T00:00:${String(index % 60).padStart(2, '0')}.000Z`, {
        sessionId,
        provider: 'pi',
        role: 'assistant',
        content: `answer-${index}`,
      }),
    );

  const appendSessionId = 'append-cap-session';
  const appendSlot = sessionStore.getSlot(appendSessionId);
  appendSlot.reconciliationState.activeServerUserId = 'append-server-user';
  for (const message of createAssistantRows(appendSessionId)) {
    sessionStore.appendRealtime(appendSessionId, message);
  }

  assert.equal(appendSlot.realtimeMessages.length, 500);
  assert.equal(appendSlot.reconciliationState.serverUserIdByRealtimeMessageId.size, 500);
  assert.equal(
    appendSlot.reconciliationState.serverUserIdByRealtimeMessageId.has(
      `live-${appendSessionId}-0`,
    ),
    false,
  );
  assert.equal(appendSlot.reconciliationState.activeServerUserId, 'append-server-user');

  const batchSessionId = 'batch-cap-session';
  const batchSlot = sessionStore.getSlot(batchSessionId);
  batchSlot.reconciliationState.activeServerUserId = 'batch-server-user';
  sessionStore.appendRealtimeBatch(
    batchSessionId,
    createAssistantRows(batchSessionId),
  );

  assert.equal(batchSlot.realtimeMessages.length, 500);
  assert.equal(batchSlot.reconciliationState.serverUserIdByRealtimeMessageId.size, 500);
  assert.equal(
    batchSlot.reconciliationState.serverUserIdByRealtimeMessageId.has(
      `live-${batchSessionId}-0`,
    ),
    false,
  );
  assert.equal(batchSlot.reconciliationState.activeServerUserId, 'batch-server-user');
});

test('bounds replay tombstones and releases them at a clean local turn boundary', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedUser = createUserMessage(
    'persisted-user',
    '2026-08-06T00:00:00.500Z',
    {
      provider: 'pi',
      content: 'prompt',
    },
  );
  const persistedAnswers = Array.from({ length: 501 }, (_, index) =>
    createUserMessage(
      `persisted-answer-${index}`,
      new Date(Date.parse('2026-08-06T00:00:01.000Z') + index).toISOString(),
      {
        provider: 'pi',
        role: 'assistant',
        content: `answer-${index}`,
      },
    ),
  );
  const liveAnswers = Array.from({ length: 501 }, (_, index) =>
    createUserMessage(
      `live-answer-${index}`,
      new Date(Date.parse('2026-08-06T00:00:00.750Z') + index).toISOString(),
      {
        provider: 'pi',
        role: 'assistant',
        content: `answer-${index}`,
      },
    ),
  );

  const remainingRealtime = pruneRealtimeSupersededByServer(
    [persistedUser, ...persistedAnswers],
    [
      createUserMessage('local_prompt', '2026-08-06T00:00:00.000Z', {
        provider: 'pi',
        content: 'prompt',
      }),
      ...liveAnswers,
    ],
    reconciliationState,
  );

  assert.deepEqual(remainingRealtime, []);
  assert.equal(
    reconciliationState.consumedServerMessageIdByRealtimeMessageId.size,
    500,
  );

  upsertRealtimeMessages(
    [],
    [
      createUserMessage('local_next', '2026-08-06T00:00:03.000Z', {
        provider: 'pi',
        content: 'next prompt',
      }),
    ],
    reconciliationState,
  );

  assert.equal(
    reconciliationState.consumedServerMessageIdByRealtimeMessageId.size,
    0,
  );
});

test('reconciles completed raw stream deltas whether terminal or missing streaming flag', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.500Z', {
      provider: 'pi',
      content: 'prompt',
    }),
    createUserMessage('persisted-answer', '2026-08-06T00:00:01.500Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];
  const localUser = createUserMessage('local_prompt', '2026-08-06T00:00:00.000Z', {
    provider: 'pi',
    content: 'prompt',
  });

  for (const overrides of [{ isStreaming: false }, {}]) {
    const remainingRealtime = pruneRealtimeSupersededByServer(
      persistedMessages,
      [
        localUser,
        createUserMessage(
          `raw-stream-${String(overrides.isStreaming ?? 'missing')}`,
          '2026-08-06T00:00:01.000Z',
          {
            provider: 'pi',
            kind: 'stream_delta',
            role: 'assistant',
            content: 'RESULT',
            ...overrides,
          },
        ),
      ],
    );

    assert.deepEqual(remainingRealtime, []);
  }

  const syntheticStream = createUserMessage(
    '__streaming_session-1',
    '2026-08-06T00:00:01.000Z',
    {
      provider: 'pi',
      kind: 'stream_delta',
      role: 'assistant',
      content: 'RESULT',
      isStreaming: false,
    },
  );
  assert.deepEqual(
    pruneRealtimeSupersededByServer(
      persistedMessages,
      [localUser, syntheticStream],
    ).map((message) => message.id),
    ['__streaming_session-1'],
  );
});

test('reconciles a terminal raw stream delta without a realtime user anchor', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'prompt',
    }),
    createUserMessage('persisted-answer', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];
  for (const overrides of [{ isStreaming: false }, {}]) {
    const rawStream = createUserMessage(
      `raw-stream-unanchored-${String(overrides.isStreaming ?? 'missing')}`,
      '2026-08-06T00:00:00.900Z',
      {
        provider: 'pi',
        kind: 'stream_delta',
        role: 'assistant',
        content: 'RESULT',
        ...overrides,
      },
    );

    assert.deepEqual(
      pruneRealtimeSupersededByServer(persistedMessages, [rawStream]),
      [],
    );
  }
});

test('keeps an unanchored raw stream when multiple persisted turns could echo it', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('first-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first',
    }),
    createUserMessage('first-answer', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
    createUserMessage('second-user', '2026-08-06T00:00:00.500Z', {
      provider: 'pi',
      content: 'second',
    }),
    createUserMessage('second-answer', '2026-08-06T00:00:03.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];
  const rawStream = createUserMessage('raw-stream-ambiguous', '2026-08-06T00:00:01.000Z', {
    provider: 'pi',
    kind: 'stream_delta',
    role: 'assistant',
    content: 'RESULT',
    isStreaming: false,
  });

  assert.deepEqual(
    pruneRealtimeSupersededByServer(persistedMessages, [rawStream]).map((message) => message.id),
    ['raw-stream-ambiguous'],
  );
});

test('keeps an unanchored raw stream before a future persisted turn', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('first-user-before-stream', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first prompt',
    }),
    createUserMessage('first-answer-before-stream', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'OLD',
    }),
    createUserMessage('future-user-after-stream', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      content: 'future prompt',
    }),
    createUserMessage('future-answer-after-stream', '2026-08-06T00:00:03.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'NEW',
    }),
  ];
  const rawStream = createUserMessage('raw-stream-before-future-turn', '2026-08-06T00:00:01.500Z', {
    provider: 'pi',
    kind: 'stream_delta',
    role: 'assistant',
    content: 'NEW',
    isStreaming: false,
  });

  assert.deepEqual(
    pruneRealtimeSupersededByServer(persistedMessages, [rawStream]).map((message) => message.id),
    ['raw-stream-before-future-turn'],
  );
});

test('does not let a late older replay inherit a newer realtime user turn', () => {
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('old-user-for-late-replay', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'old prompt',
    }),
    createUserMessage('old-answer-for-late-replay', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'OLD',
    }),
    createUserMessage('new-user-for-late-replay', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      content: 'new prompt',
    }),
    createUserMessage('new-answer-for-late-replay', '2026-08-06T00:00:03.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'NEW',
    }),
  ];
  const localUser = createUserMessage('local_new_for_late_replay', '2026-08-06T00:00:01.900Z', {
    provider: 'pi',
    content: 'new prompt',
  });
  const lateReplay = createUserMessage('late-old-replay', '2026-08-06T00:00:01.500Z', {
    provider: 'pi',
    kind: 'stream_delta',
    role: 'assistant',
    content: 'NEW',
    isStreaming: false,
  });

  assert.deepEqual(
    pruneRealtimeSupersededByServer(persistedMessages, [localUser, lateReplay])
      .map((message) => message.id),
    ['late-old-replay'],
  );
});

test('rebases stale lineage before an unanchored stream in a later persisted turn', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const firstTurn: NormalizedMessage[] = [
    createUserMessage('first-persisted-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first prompt',
    }),
    createUserMessage('first-persisted-answer', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  assert.deepEqual(
    pruneRealtimeSupersededByServer(
      firstTurn,
      [
        createUserMessage('local_first-user', '2026-08-06T00:00:00.000Z', {
          provider: 'pi',
          content: 'first prompt',
        }),
        createUserMessage('first-live-answer', '2026-08-06T00:00:00.900Z', {
          provider: 'pi',
          role: 'assistant',
          content: 'SAME',
        }),
      ],
      reconciliationState,
    ),
    [],
  );

  const hiddenReplay = createUserMessage('hidden-old-replay', '2026-08-06T00:00:01.100Z', {
    provider: 'pi',
    role: 'assistant',
    content: 'SAME',
  });
  upsertRealtimeMessages([], [hiddenReplay], reconciliationState);

  const secondTurn = [
    ...firstTurn,
    createUserMessage('second-persisted-user', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      content: 'second prompt',
    }),
    createUserMessage('second-persisted-answer', '2026-08-06T00:00:03.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  assert.deepEqual(
    pruneRealtimeSupersededByServer(
      secondTurn,
      [hiddenReplay, createUserMessage('second-raw-answer', '2026-08-06T00:00:02.900Z', {
        provider: 'pi',
        kind: 'stream_delta',
        role: 'assistant',
        content: 'SAME',
        isStreaming: false,
      })],
      reconciliationState,
    ),
    [hiddenReplay],
  );
});

test('store keeps an old hidden replay from anchoring the next turn', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'stale-hidden-replay-session';
  const slot = sessionStore.getSlot(sessionId);
  const firstTurn: NormalizedMessage[] = [
    createUserMessage('store-first-user', '2026-08-06T00:00:00.000Z', {
      provider: 'pi',
      content: 'first prompt',
    }),
    createUserMessage('store-first-answer', '2026-08-06T00:00:01.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];
  slot.serverMessages = firstTurn;
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_store-first',
    '2026-08-06T00:00:00.000Z',
    { provider: 'pi', content: 'first prompt' },
  ));
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'store-first-live',
    '2026-08-06T00:00:00.900Z',
    { provider: 'pi', role: 'assistant', content: 'SAME' },
  ));

  const hiddenReplay = createUserMessage('store-hidden-old', '2026-08-06T00:00:01.100Z', {
    provider: 'pi',
    role: 'assistant',
    content: 'SAME',
  });
  sessionStore.appendRealtime(sessionId, hiddenReplay);

  const secondTurn = [
    ...firstTurn,
    createUserMessage('store-second-user', '2026-08-06T00:00:02.000Z', {
      provider: 'pi',
      content: 'second prompt',
    }),
    createUserMessage('store-second-answer', '2026-08-06T00:00:03.000Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];
  slot.serverMessages = secondTurn;
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'store-second-raw',
    '2026-08-06T00:00:02.900Z',
    {
      provider: 'pi',
      kind: 'stream_delta',
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    },
  ));

  assert.deepEqual(slot.realtimeMessages.map((message) => message.id), [hiddenReplay.id]);
  assert.equal(slot.merged.some((message) => message.id === 'store-second-raw'), false);
});

test('store keeps a late old replay after the newer user has reconciled', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'late-old-replay-after-new-user';
  const slot = sessionStore.getSlot(sessionId);
  const oldUser = createUserMessage('late-old-user', '2026-08-06T00:00:00.000Z', {
    sessionId,
    provider: 'pi',
    content: 'old prompt',
  });
  const oldAnswer = createUserMessage('late-old-answer', '2026-08-06T00:00:01.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'SAME',
  });
  const newUser = createUserMessage('late-new-user', '2026-08-06T00:00:02.000Z', {
    sessionId,
    provider: 'pi',
    content: 'new prompt',
  });
  const newAnswer = createUserMessage('late-new-answer', '2026-08-06T00:00:03.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'SAME',
  });
  slot.serverMessages = [oldUser, oldAnswer, newUser];

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_new_late_replay',
    '2026-08-06T00:00:01.900Z',
    { sessionId, provider: 'pi', content: 'new prompt' },
  ));
  assert.equal(slot.realtimeMessages.length, 0);
  assert.equal(slot.reconciliationState.activeServerUserId, newUser.id);

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'hidden_late_old_replay',
    '2026-08-06T00:00:01.500Z',
    {
      sessionId,
      provider: 'pi',
      kind: 'stream_delta',
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    },
  ));
  assert.deepEqual(
    slot.realtimeMessages.map((message) => message.id),
    ['hidden_late_old_replay'],
  );

  slot.serverMessages = [oldUser, oldAnswer, newUser, newAnswer];
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'new_live_answer_after_replay',
    '2026-08-06T00:00:03.100Z',
    { sessionId, provider: 'pi', role: 'assistant', content: 'SAME' },
  ));

  assert.deepEqual(
    slot.realtimeMessages.map((message) => message.id),
    ['hidden_late_old_replay'],
  );
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(
      'hidden_late_old_replay',
    ),
    undefined,
  );
});

test('store clears stale lineage when a newer persisted user has an invalid timestamp', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'invalid-newer-persisted-user-timestamp';
  const slot = sessionStore.getSlot(sessionId);
  const oldUser = createUserMessage('invalid-time-old-user', '2026-08-06T00:00:00.000Z', {
    sessionId,
    provider: 'pi',
    content: 'old prompt',
  });
  const oldAnswer = createUserMessage('invalid-time-old-answer', '2026-08-06T00:00:01.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'SAME',
  });
  const newUser = createUserMessage('invalid-time-new-user', 'not-a-timestamp', {
    sessionId,
    provider: 'pi',
    content: 'new prompt',
  });

  slot.serverMessages = [oldUser, oldAnswer];
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_invalid_time_old_user',
    '2026-08-05T23:59:59.900Z',
    { sessionId, provider: 'pi', content: 'old prompt' },
  ));
  assert.equal(slot.reconciliationState.activeServerUserId, oldUser.id);

  slot.serverMessages = [oldUser, oldAnswer, newUser];
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'invalid-time-new-terminal-raw',
    '2026-08-06T00:00:02.000Z',
    {
      sessionId,
      provider: 'pi',
      kind: 'stream_delta',
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    },
  ));

  assert.deepEqual(
    slot.realtimeMessages.map((message) => message.id),
    ['invalid-time-new-terminal-raw'],
  );
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(
      'invalid-time-new-terminal-raw',
    ),
    undefined,
  );
  assert.equal(
    slot.merged.some((message) => message.id === 'invalid-time-new-terminal-raw'),
    true,
  );
});

test('store does not infer a raw stream echo across an invalid user timestamp', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'invalid-user-boundary-unanchored-stream';
  const slot = sessionStore.getSlot(sessionId);
  slot.serverMessages = [
    createUserMessage('invalid-boundary-old-user', '2026-08-06T00:00:00.000Z', {
      sessionId,
      provider: 'pi',
      content: 'old prompt',
    }),
    createUserMessage('invalid-boundary-old-answer', '2026-08-06T00:00:01.000Z', {
      sessionId,
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
    createUserMessage('invalid-boundary-new-user', 'not-a-timestamp', {
      sessionId,
      provider: 'pi',
      content: 'new prompt',
    }),
    createUserMessage('invalid-boundary-new-answer', '2026-08-06T00:00:03.000Z', {
      sessionId,
      provider: 'pi',
      role: 'assistant',
      content: 'SAME',
    }),
  ];

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'invalid-boundary-late-old-terminal',
    '2026-08-06T00:00:01.100Z',
    {
      sessionId,
      provider: 'pi',
      kind: 'stream_delta',
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    },
  ));

  assert.deepEqual(
    slot.realtimeMessages.map((message) => message.id),
    ['invalid-boundary-late-old-terminal'],
  );
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(
      'invalid-boundary-late-old-terminal',
    ),
    undefined,
  );
  assert.equal(
    slot.merged.some((message) => message.id === 'invalid-boundary-late-old-terminal'),
    true,
  );
});

test('store keeps a late finalized assistant replay before the active user anchor', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'late-finalized-replay-before-active-anchor';
  const slot = sessionStore.getSlot(sessionId);
  const oldUser = createUserMessage('finalized-replay-old-user', '2026-08-06T00:00:00.000Z', {
    sessionId,
    provider: 'pi',
    content: 'old prompt',
  });
  const oldAnswer = createUserMessage('finalized-replay-old-answer', '2026-08-06T00:00:01.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'SAME',
  });
  const newUser = createUserMessage('finalized-replay-new-user', '2026-08-06T00:00:02.000Z', {
    sessionId,
    provider: 'pi',
    content: 'new prompt',
  });
  const newAnswer = createUserMessage('finalized-replay-new-answer', '2026-08-06T00:00:03.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'SAME',
  });
  slot.serverMessages = [oldUser, oldAnswer, newUser];

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_finalized_replay_new_user',
    '2026-08-06T00:00:01.900Z',
    { sessionId, provider: 'pi', content: 'new prompt' },
  ));
  assert.equal(slot.reconciliationState.activeServerUserId, newUser.id);

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'late_finalized_replay',
    '2026-08-06T00:00:01.500Z',
    { sessionId, provider: 'pi', role: 'assistant', content: 'SAME' },
  ));
  assert.deepEqual(
    slot.realtimeMessages.map((message) => message.id),
    ['late_finalized_replay'],
  );

  slot.serverMessages = [oldUser, oldAnswer, newUser, newAnswer];
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'new_live_after_late_finalized_replay',
    '2026-08-06T00:00:03.100Z',
    { sessionId, provider: 'pi', role: 'assistant', content: 'SAME' },
  ));

  assert.deepEqual(
    slot.realtimeMessages.map((message) => message.id),
    ['late_finalized_replay'],
  );
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(
      'late_finalized_replay',
    ),
    undefined,
  );
});

test('store keeps late thinking and streaming replays before the active user anchor', async () => {
  const sessionStore = await renderSessionStore();
  const variants: Array<{
    name: string;
    content: string;
    persistedKind: NormalizedMessage['kind'];
    lateKind: NormalizedMessage['kind'];
    actualKind: NormalizedMessage['kind'];
    streamingLifecycle: boolean;
  }> = [
    {
      name: 'thinking',
      content: 'SAME THINKING',
      persistedKind: 'thinking',
      lateKind: 'thinking',
      actualKind: 'thinking',
      streamingLifecycle: false,
    },
    {
      name: 'stream',
      content: 'SAME STREAM',
      persistedKind: 'text',
      lateKind: 'stream_delta',
      actualKind: 'text',
      streamingLifecycle: true,
    },
  ];

  for (const variant of variants) {
    const sessionId = `late-${variant.name}-replay-before-active-anchor`;
    const slot = sessionStore.getSlot(sessionId);
    const oldUser = createUserMessage(`${variant.name}-old-user`, '2026-08-06T00:00:00.000Z', {
      sessionId,
      provider: 'pi',
      content: 'old prompt',
    });
    const oldEcho = createUserMessage(`${variant.name}-old-echo`, '2026-08-06T00:00:01.000Z', {
      sessionId,
      provider: 'pi',
      kind: variant.persistedKind,
      role: 'assistant',
      content: variant.content,
      isStreaming: false,
    });
    const newUser = createUserMessage(`${variant.name}-new-user`, '2026-08-06T00:00:02.000Z', {
      sessionId,
      provider: 'pi',
      content: 'new prompt',
    });
    const newEcho = createUserMessage(`${variant.name}-new-echo`, '2026-08-06T00:00:03.000Z', {
      sessionId,
      provider: 'pi',
      kind: variant.persistedKind,
      role: 'assistant',
      content: variant.content,
      isStreaming: false,
    });
    slot.serverMessages = [oldUser, oldEcho, newUser];

    sessionStore.appendRealtime(sessionId, createUserMessage(
      `local_${variant.name}_new_user`,
      '2026-08-06T00:00:01.900Z',
      { sessionId, provider: 'pi', content: 'new prompt' },
    ));

    const lateReplay = createUserMessage(
      `late_${variant.name}_replay`,
      '2026-08-06T00:00:01.500Z',
      {
        sessionId,
        provider: 'pi',
        kind: variant.lateKind,
        role: 'assistant',
        content: variant.content,
        isStreaming: variant.streamingLifecycle,
      },
    );
    sessionStore.appendRealtime(sessionId, lateReplay);
    if (variant.streamingLifecycle) {
      sessionStore.appendRealtime(sessionId, { ...lateReplay, isStreaming: false });
    }

    slot.serverMessages = [oldUser, oldEcho, newUser, newEcho];
    sessionStore.appendRealtime(sessionId, createUserMessage(
      `current_${variant.name}_live`,
      '2026-08-06T00:00:03.100Z',
      {
        sessionId,
        provider: 'pi',
        kind: variant.actualKind,
        role: 'assistant',
        content: variant.content,
        isStreaming: false,
      },
    ));

    assert.deepEqual(
      slot.realtimeMessages.map((message) => message.id),
      [lateReplay.id],
    );
    assert.equal(
      slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(lateReplay.id),
      undefined,
    );
  }
});

test('store retains sequential assistant lineage across persisted user clock skew', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'sequential-assistant-persisted-user-clock-skew';
  const slot = sessionStore.getSlot(sessionId);
  const persistedUser = createUserMessage(
    'clock-skew-persisted-user',
    '2026-08-06T00:00:05.500Z',
    { sessionId, provider: 'pi', content: 'prompt' },
  );
  const liveAnswer = createUserMessage(
    'clock-skew-live-answer',
    '2026-08-06T00:00:05.200Z',
    { sessionId, provider: 'pi', role: 'assistant', content: 'RESULT' },
  );
  slot.serverMessages = [persistedUser];

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_clock_skew_prompt',
    '2026-08-06T00:00:05.000Z',
    { sessionId, provider: 'pi', content: 'prompt' },
  ));
  assert.equal(slot.realtimeMessages.length, 0);
  assert.equal(slot.reconciliationState.activeServerUserId, persistedUser.id);

  sessionStore.appendRealtime(sessionId, liveAnswer);
  assert.deepEqual(
    slot.realtimeMessages.map((message) => message.id),
    [liveAnswer.id],
  );

  slot.serverMessages = [
    persistedUser,
    createUserMessage('clock-skew-persisted-answer', '2026-08-06T00:00:06.000Z', {
      sessionId,
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];
  sessionStore.appendRealtime(sessionId, liveAnswer);

  assert.deepEqual(slot.realtimeMessages, []);
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(liveAnswer.id),
    'clock-skew-persisted-answer',
  );
});

test('store keeps the active turn when persisted user timestamps move backwards across turns', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'cross-turn-clock-rollback';
  const slot = sessionStore.getSlot(sessionId);
  const oldUser = createUserMessage('rollback-old-user', '2026-08-06T00:00:10.000Z', {
    sessionId,
    provider: 'pi',
    content: 'old prompt',
  });
  const oldAnswer = createUserMessage('rollback-old-answer', '2026-08-06T00:00:11.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });
  const newUser = createUserMessage('rollback-new-user', '2026-08-06T00:00:05.500Z', {
    sessionId,
    provider: 'pi',
    content: 'new prompt',
  });
  const liveAnswer = createUserMessage('rollback-live-answer', '2026-08-06T00:00:05.200Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });
  const newAnswer = createUserMessage('rollback-new-answer', '2026-08-06T00:00:06.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });

  // Provider history adapters return timestamp-ordered rows, so the older
  // turn can appear after the newer turn when the provider clock rolls back.
  slot.serverMessages = [oldUser, oldAnswer, newUser];
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_rollback-new-user',
    '2026-08-06T00:00:05.000Z',
    { sessionId, provider: 'pi', content: 'new prompt' },
  ));
  assert.equal(slot.reconciliationState.activeServerUserId, newUser.id);

  sessionStore.appendRealtime(sessionId, liveAnswer);
  slot.serverMessages = [newUser, newAnswer, oldUser, oldAnswer];
  sessionStore.appendRealtime(sessionId, liveAnswer);

  assert.deepEqual(slot.realtimeMessages, []);
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(liveAnswer.id),
    newAnswer.id,
  );
});

test('store keeps the active turn when clock-rollback history preserves structural order', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'cross-turn-clock-rollback-structural-order';
  const slot = sessionStore.getSlot(sessionId);
  const oldUser = createUserMessage('structural-old-user', '2026-08-06T00:00:10.000Z', {
    sessionId,
    provider: 'pi',
    content: 'old prompt',
  });
  const oldAnswer = createUserMessage('structural-old-answer', '2026-08-06T00:00:11.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });
  const newUser = createUserMessage('structural-new-user', '2026-08-06T00:00:05.500Z', {
    sessionId,
    provider: 'pi',
    content: 'new prompt',
  });
  const liveAnswer = createUserMessage('structural-live-answer', '2026-08-06T00:00:05.200Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });
  const newAnswer = createUserMessage('structural-new-answer', '2026-08-06T00:00:06.000Z', {
    sessionId,
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });

  slot.serverMessages = [oldUser, oldAnswer, newUser];
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_structural-new-user',
    '2026-08-06T00:00:05.000Z',
    { sessionId, provider: 'pi', content: 'new prompt' },
  ));
  assert.equal(slot.reconciliationState.activeServerUserId, newUser.id);

  sessionStore.appendRealtime(sessionId, liveAnswer);
  // Some providers retain insertion order even when individual timestamps
  // move backwards across turns; do not assume the array is timestamp-sorted.
  slot.serverMessages = [oldUser, oldAnswer, newUser, newAnswer];
  sessionStore.appendRealtime(sessionId, liveAnswer);

  assert.deepEqual(slot.realtimeMessages, []);
  assert.equal(
    slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(liveAnswer.id),
    newAnswer.id,
  );
});

test('store keeps clock-rollback lineage for thinking and streaming terminal rows', async () => {
  const sessionStore = await renderSessionStore();
  const variants: Array<{
    name: string;
    realtimeKind: NormalizedMessage['kind'];
    persistedKind: NormalizedMessage['kind'];
    terminalKind?: NormalizedMessage['kind'];
    streaming: boolean;
  }> = [
    {
      name: 'thinking',
      realtimeKind: 'thinking',
      persistedKind: 'thinking',
      streaming: false,
    },
    {
      name: 'stream',
      realtimeKind: 'stream_delta',
      persistedKind: 'text',
      terminalKind: 'text',
      streaming: true,
    },
  ];

  for (const variant of variants) {
    const sessionId = `cross-turn-clock-rollback-${variant.name}`;
    const slot = sessionStore.getSlot(sessionId);
    const oldUser = createUserMessage(`${variant.name}-rollback-old-user`, '2026-08-06T00:00:10.000Z', {
      sessionId,
      provider: 'pi',
      content: 'old prompt',
    });
    const oldEcho = createUserMessage(`${variant.name}-rollback-old-echo`, '2026-08-06T00:00:11.000Z', {
      sessionId,
      provider: 'pi',
      kind: variant.persistedKind,
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    });
    const newUser = createUserMessage(`${variant.name}-rollback-new-user`, '2026-08-06T00:00:05.500Z', {
      sessionId,
      provider: 'pi',
      content: 'new prompt',
    });
    const newEcho = createUserMessage(`${variant.name}-rollback-new-echo`, '2026-08-06T00:00:06.000Z', {
      sessionId,
      provider: 'pi',
      kind: variant.persistedKind,
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    });
    const lateReplay = createUserMessage(`${variant.name}-rollback-live`, '2026-08-06T00:00:05.200Z', {
      sessionId,
      provider: 'pi',
      kind: variant.realtimeKind,
      role: 'assistant',
      content: 'SAME',
      isStreaming: variant.streaming,
    });

    slot.serverMessages = [oldUser, oldEcho, newUser];
    sessionStore.appendRealtime(sessionId, createUserMessage(
      `local_${variant.name}-rollback-new-user`,
      '2026-08-06T00:00:05.000Z',
      { sessionId, provider: 'pi', content: 'new prompt' },
    ));
    assert.equal(slot.reconciliationState.activeServerUserId, newUser.id);

    sessionStore.appendRealtime(sessionId, lateReplay);
    slot.serverMessages = [newUser, newEcho, oldUser, oldEcho];
    sessionStore.appendRealtime(sessionId, {
      ...lateReplay,
      kind: variant.terminalKind ?? lateReplay.kind,
      isStreaming: false,
    });

    assert.deepEqual(slot.realtimeMessages, []);
    assert.equal(
      slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(lateReplay.id),
      newEcho.id,
    );
  }
});

test('store keeps clock-rollback lineage for structural-order thinking and streaming rows', async () => {
  const sessionStore = await renderSessionStore();
  const variants: Array<{
    name: string;
    realtimeKind: NormalizedMessage['kind'];
    persistedKind: NormalizedMessage['kind'];
    terminalKind?: NormalizedMessage['kind'];
    streaming: boolean;
  }> = [
    {
      name: 'thinking',
      realtimeKind: 'thinking',
      persistedKind: 'thinking',
      streaming: false,
    },
    {
      name: 'stream',
      realtimeKind: 'stream_delta',
      persistedKind: 'text',
      terminalKind: 'text',
      streaming: true,
    },
  ];

  for (const variant of variants) {
    const sessionId = `cross-turn-clock-rollback-structural-${variant.name}`;
    const slot = sessionStore.getSlot(sessionId);
    const oldUser = createUserMessage(`${variant.name}-structural-old-user`, '2026-08-06T00:00:10.000Z', {
      sessionId,
      provider: 'pi',
      content: 'old prompt',
    });
    const oldEcho = createUserMessage(`${variant.name}-structural-old-echo`, '2026-08-06T00:00:11.000Z', {
      sessionId,
      provider: 'pi',
      kind: variant.persistedKind,
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    });
    const newUser = createUserMessage(`${variant.name}-structural-new-user`, '2026-08-06T00:00:05.500Z', {
      sessionId,
      provider: 'pi',
      content: 'new prompt',
    });
    const newEcho = createUserMessage(`${variant.name}-structural-new-echo`, '2026-08-06T00:00:06.000Z', {
      sessionId,
      provider: 'pi',
      kind: variant.persistedKind,
      role: 'assistant',
      content: 'SAME',
      isStreaming: false,
    });
    const replay = createUserMessage(`${variant.name}-structural-replay`, '2026-08-06T00:00:05.200Z', {
      sessionId,
      provider: 'pi',
      kind: variant.realtimeKind,
      role: 'assistant',
      content: 'SAME',
      isStreaming: variant.streaming,
    });

    slot.serverMessages = [oldUser, oldEcho, newUser];
    sessionStore.appendRealtime(sessionId, createUserMessage(
      `local_${variant.name}-structural-new-user`,
      '2026-08-06T00:00:05.000Z',
      { sessionId, provider: 'pi', content: 'new prompt' },
    ));
    assert.equal(slot.reconciliationState.activeServerUserId, newUser.id);

    sessionStore.appendRealtime(sessionId, replay);
    slot.serverMessages = [oldUser, oldEcho, newUser, newEcho];
    sessionStore.appendRealtime(sessionId, {
      ...replay,
      kind: variant.terminalKind ?? replay.kind,
      isStreaming: false,
    });

    assert.deepEqual(slot.realtimeMessages, []);
    assert.equal(
      slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.get(replay.id),
      newEcho.id,
    );
  }
});

test('cleans hidden replay lineage before the next local turn', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'hidden-replay-session';
  const slot = sessionStore.getSlot(sessionId);
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedMessages: NormalizedMessage[] = [
    createUserMessage('persisted-user', '2026-08-06T00:00:00.500Z', {
      provider: 'pi',
      content: 'prompt',
    }),
    createUserMessage('persisted-answer', '2026-08-06T00:00:01.500Z', {
      provider: 'pi',
      role: 'assistant',
      content: 'RESULT',
    }),
  ];
  const localUser = createUserMessage('local_prompt', '2026-08-06T00:00:00.000Z', {
    provider: 'pi',
    content: 'prompt',
  });
  const liveAnswer = createUserMessage('live-answer', '2026-08-06T00:00:01.000Z', {
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });

  assert.deepEqual(
    pruneRealtimeSupersededByServer(
      persistedMessages,
      [localUser, liveAnswer],
      reconciliationState,
    ),
    [],
  );

  const replayedMessages = upsertRealtimeMessages(
    [],
    [liveAnswer],
    reconciliationState,
  );
  slot.serverMessages = persistedMessages;
  slot.realtimeMessages = replayedMessages;
  slot.reconciliationState = reconciliationState;
  sessionStore.appendRealtime(sessionId, liveAnswer);
  assert.deepEqual(sessionStore.getMessages(sessionId), persistedMessages);

  sessionStore.appendRealtime(sessionId, createUserMessage('local_next', '2026-08-06T00:00:03.000Z', {
      provider: 'pi',
      content: 'next prompt',
    }));

  assert.deepEqual(slot.realtimeMessages.map((message) => message.id), ['local_next']);
  assert.equal(slot.reconciliationState.serverUserIdByRealtimeMessageId.size, 0);
  assert.equal(slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.size, 0);
  assert.equal(slot.reconciliationState.claimedServerMessageIds.size, 0);
});

test('store writes hidden replay reconciliation back to raw realtime state', async () => {
  const sessionStore = await renderSessionStore();
  const sessionId = 'store-hidden-replay';
  const slot = sessionStore.getSlot(sessionId);
  const persistedUser = createUserMessage('persisted-user', '2026-08-06T00:00:00.500Z', {
    provider: 'pi',
    content: 'prompt',
  });
  const persistedAnswer = createUserMessage('persisted-answer', '2026-08-06T00:00:01.500Z', {
    provider: 'pi',
    role: 'assistant',
    content: 'RESULT',
  });
  slot.serverMessages = [persistedUser, persistedAnswer];

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_prompt',
    '2026-08-06T00:00:00.000Z',
    { provider: 'pi', content: 'prompt' },
  ));
  sessionStore.appendRealtime(sessionId, createUserMessage(
    'live_answer',
    '2026-08-06T00:00:01.000Z',
    { provider: 'pi', role: 'assistant', content: 'RESULT' },
  ));

  assert.deepEqual(slot.merged.map((message) => message.id), [
    'persisted-user',
    'persisted-answer',
  ]);
  assert.deepEqual(slot.realtimeMessages, []);

  sessionStore.appendRealtime(sessionId, createUserMessage(
    'local_next',
    '2026-08-06T00:00:03.000Z',
    { provider: 'pi', content: 'next prompt' },
  ));
  assert.equal(slot.reconciliationState.claimedServerMessageIds.size, 0);
  assert.equal(slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.size, 0);

  const stateBeforeClear = slot.reconciliationState;
  sessionStore.clearRealtime(sessionId);
  assert.notEqual(slot.reconciliationState, stateBeforeClear);
  assert.deepEqual(slot.realtimeMessages, []);
  assert.equal(slot.reconciliationState.serverUserIdByRealtimeMessageId.size, 0);
  assert.equal(slot.reconciliationState.claimedServerMessageIds.size, 0);
  assert.equal(slot.reconciliationState.consumedServerMessageIdByRealtimeMessageId.size, 0);
});

test('bounds claimed server message ids for a large persisted transcript', () => {
  const reconciliationState = createSessionMessageReconciliationState();
  const persistedMessages = Array.from({ length: 10_000 }, (_, index) =>
    createUserMessage(`persisted-${index}`, `2026-08-06T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`, {
      provider: 'pi',
      role: 'assistant',
      content: `answer-${index}`,
    }));
  const realtimeMessages = persistedMessages.map((message) => ({ ...message }));

  const remainingRealtime = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
    reconciliationState,
  );

  assert.deepEqual(remainingRealtime, []);
  assert.ok(reconciliationState.claimedServerMessageIds.size <= 500);

  const duplicateRefresh = pruneRealtimeSupersededByServer(
    persistedMessages,
    realtimeMessages,
    reconciliationState,
  );
  assert.deepEqual(duplicateRefresh, []);
  assert.ok(reconciliationState.claimedServerMessageIds.size <= 500);

  upsertRealtimeMessages(
    [],
    [createUserMessage('local_next', '2026-08-06T00:01:00.000Z', {
      provider: 'pi',
      content: 'next prompt',
    })],
    reconciliationState,
  );
  assert.equal(reconciliationState.claimedServerMessageIds.size, 0);
  assert.equal(reconciliationState.consumedServerMessageIdByRealtimeMessageId.size, 0);
});
