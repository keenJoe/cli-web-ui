import { useEffect, useRef } from 'react';

import {
  clearQueuedMessage,
  readQueuedMessage,
  type StoredQueuedMessage,
} from '../components/chat/utils/chatStorage';
import { resolveQueuedSendOptions } from '../components/chat/utils/queuedSendValidation';

import type { MarkSessionProcessing, SessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: SessionActivityMap;
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles file attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  markSessionProcessing: MarkSessionProcessing;
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft under `queued_message_<sessionId>`.
 * When a run finishes, this hook revalidates its snapshot against current
 * backend capabilities, catalog, and active model before claiming and sending
 * it. Unverifiable drafts remain stored for a later retry or composer replay.
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  ws,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const prev = prevProcessingRef.current;
    const current = new Set(processingSessions.keys());
    prevProcessingRef.current = current;

    const queuedMessageStillMatches = (
      expected: StoredQueuedMessage,
      actual: StoredQueuedMessage | null,
    ) => Boolean(
      actual
      && actual.content === expected.content
      && actual.provider === expected.provider
      && JSON.stringify(actual.options ?? {}) === JSON.stringify(expected.options ?? {})
      && JSON.stringify(actual.attachments ?? []) === JSON.stringify(expected.attachments ?? []),
    );

    const validateAndSend = async (sessionId: string, queued: StoredQueuedMessage) => {
      if (!queued.provider) {
        return;
      }
      const validatedOptions = await resolveQueuedSendOptions({
        provider: queued.provider,
        sessionId,
        options: queued.options,
      });
      if (
        cancelled
        || !validatedOptions
        || sessionId === activeSessionId
        || processingSessions.has(sessionId)
        || !ws
        || ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      const latestQueued = readQueuedMessage(sessionId);
      if (!queuedMessageStillMatches(queued, latestQueued)) {
        return;
      }

      clearQueuedMessage(sessionId);
      sendMessage({
        type: 'chat.send',
        sessionId,
        content: queued.content,
        options: { ...validatedOptions, attachments: queued.attachments ?? [] },
      });
      markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
    };

    for (const sessionId of prev) {
      if (current.has(sessionId) || sessionId === activeSessionId) {
        continue;
      }

      const queued = readQueuedMessage(sessionId);
      if (!queued) {
        continue;
      }

      // A closed socket would drop the send silently; keep the draft so the
      // composer (or a later completion) can retry once we're connected.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      void validateAndSend(sessionId, queued);
    }

    return () => {
      cancelled = true;
    };
  }, [processingSessions, activeSessionId, ws, sendMessage, markSessionProcessing]);
}
