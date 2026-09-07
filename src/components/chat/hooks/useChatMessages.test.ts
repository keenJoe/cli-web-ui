import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

const createMessage = (
  overrides: Partial<NormalizedMessage>,
): NormalizedMessage => ({
  id: 'message-1',
  sessionId: 'session-1',
  timestamp: '2026-08-04T00:00:00.000Z',
  provider: 'pi',
  kind: 'tool_use',
  ...overrides,
});

test('Pi top-level realtime tool results attach to their tool calls', () => {
  const toolUseResult = { path: 'README.md' };
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'tool-use-top-level',
      kind: 'tool_use',
      toolId: 'tool-top-level',
      toolName: 'read',
      toolInput: { path: 'README.md' },
    }),
    createMessage({
      id: 'tool-result-top-level',
      kind: 'tool_result',
      toolId: 'tool-top-level',
      content: 'file body',
      isError: false,
      toolUseResult,
    }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.toolResult?.content, 'file body');
  assert.equal(converted[0]?.toolResult?.isError, false);
  assert.deepEqual(converted[0]?.toolResult?.toolUseResult, toolUseResult);
});

test('Pi nested realtime tool results attach without crashing the conversation', () => {
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'tool-use-1',
      kind: 'tool_use',
      toolId: 'tool-1',
      toolName: 'read',
      toolInput: { path: 'README.md' },
    }),
    createMessage({
      id: 'tool-result-1',
      kind: 'tool_result',
      toolId: 'tool-1',
      toolResult: { content: 'file body', isError: false },
      isError: false,
    }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.toolResult?.content, 'file body');
  assert.equal(converted[0]?.toolResult?.isError, false);
});

test('a malformed tool result with no content cannot crash the conversation', () => {
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'tool-use-2',
      kind: 'tool_use',
      toolId: 'tool-2',
      toolName: 'read',
    }),
    createMessage({
      id: 'tool-result-2',
      kind: 'tool_result',
      toolId: 'tool-2',
    }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.toolResult?.content, '');
});

test('thinking messages preserve stable identity and streaming metadata for Reasoning', () => {
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'thinking-stable-1',
      kind: 'thinking',
      content: 'considering the request',
      isStreaming: true,
      duration: 3,
    }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.id, 'thinking-stable-1');
  assert.equal(converted[0]?.isThinking, true);
  assert.equal(converted[0]?.isStreaming, true);
  assert.equal(converted[0]?.duration, 3);
});

// ─── Vision-bridge rendering (task group 7.3/7.6) ───────────────────────────

test('a vision_bridge message does not render as a standalone bubble or swallow body text', () => {
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'vb-1',
      kind: 'vision_bridge' as never,
      content: '观察: a cat',
      observationId: 'obs-1',
      phase: 'succeeded',
    } as Partial<NormalizedMessage>),
    createMessage({
      id: 'text-1',
      kind: 'text',
      role: 'assistant',
      content: 'Here is the answer.',
    }),
  ]);

  // Only the assistant text bubble survives; the vision_bridge control row
  // never becomes a rendered message, and the assistant body is intact.
  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.content, 'Here is the answer.');
});

test('a user message with a fake vision-bridge marker in body text renders as plain text and no card', () => {
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'user-spoof',
      kind: 'text',
      role: 'user',
      content: '[图片 #1 视觉桥已查看] describe this',
    }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.type, 'user');
  // The spoofed marker is preserved verbatim — not interpreted, no card.
  assert.equal(converted[0]?.content, '[图片 #1 视觉桥已查看] describe this');
  assert.equal((converted[0] as { visionBridge?: unknown }).visionBridge, undefined);
});

test('original user images are preserved on the user bubble', () => {
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'user-img',
      kind: 'text',
      role: 'user',
      content: 'describe this',
      images: [{ path: '/assets/a.png', name: 'a.png' }],
    }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.type, 'user');
  assert.equal(converted[0]?.images?.length, 1);
});

test('clientMessageId is carried onto the user message for card anchoring', () => {
  const converted = normalizedToChatMessages([
    createMessage({
      id: 'user-cm',
      kind: 'text',
      role: 'user',
      content: 'describe this',
      clientMessageId: 'cm-7',
    } as Partial<NormalizedMessage>),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.clientMessageId, 'cm-7');
});
