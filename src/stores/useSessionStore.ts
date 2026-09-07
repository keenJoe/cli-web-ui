/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';

import {
  createSessionMessageReconciliationState,
  reconcileAndMergeSessionMessages,
  reconcileSessionMessages,
  remapRealtimeMessageLineage,
  retainRealtimeMessageLineage,
  upsertRealtimeMessages,
  type SessionMessageReconciliationState,
} from './sessionMessageReconciliation';
import type {
  VisionBridgeCard,
  VisionBridgeSessionState,
} from './visionBridgeState';
import type {
  VisionBridgeRunEventV1,
  VisionBridgeRunPhase,
  VisionBridgeRunSource,
} from '../../shared/vision-bridge';
import {
  applyVisionBridgeEvent,
  createVisionBridgeSessionState,
  projectVisionBridgeCards,
  synthesizeCancelledOnAbort,
} from './visionBridgeState';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  | 'vision_bridge';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /** True while a logical message is still receiving live snapshot updates. */
  isStreaming?: boolean;
  /** Completed reasoning duration in whole seconds. */
  duration?: number;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  files?: Array<{ path?: string; name?: string; mimeType?: string; size?: number }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content?: string; isError?: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  toolUseResult?: unknown;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;

  // ─── Vision-bridge structured observation fields (kind === 'vision_bridge') ──
  /** Server-validated structured event payload (design.md D4/D7). */
  event?: VisionBridgeRunEventV1;
  /** CloudCLI run id; authoritative, server-overwrites child claims. */
  runId?: string;
  /** App-facing session id; authoritative. */
  appSessionId?: string;
  /** Logical identity of one image position across all phases. */
  observationId?: string;
  /** Current phase of this observation. */
  phase?: VisionBridgeRunPhase;
  /** Mutually exclusive image-source union. */
  source?: VisionBridgeRunSource;
  /** 1-based image index within the original message. */
  imageIndex?: number;
  /** Raw-byte SHA-256; cache/verification only, never message identity. */
  contentHash?: string;
  /** Flattened clientMessageId when source.kind === 'user' (rendering anchor). */
  clientMessageId?: string;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  reconciliationState: SessionMessageReconciliationState;
  /** @internal Cache-invalidation refs for merged message computation. */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  _lastReconciliationStateRef: SessionMessageReconciliationState;
  /**
   * @internal Monotonic ticket per server fetch (fetch/refresh/fetchMore) and
   * the ticket of the last response applied. Concurrent fetches for the same
   * session can resolve out of order — e.g. the `complete` refresh racing the
   * watcher-triggered refresh right as a queued message is flushed — and a
   * stale response applied last would wind `serverMessages` back to a
   * transcript that no longer matches what the user already saw.
   */
  _fetchSeq: number;
  _appliedFetchSeq: number;
  /**
   * Structured vision-bridge observation state for this session. Realtime
   * `vision_bridge` events and history batch items reduce into it; it is the
   * single source of truth for vision-bridge cards (design.md D4/D11).
   */
  visionBridge: VisionBridgeSessionState;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  const reconciliationState = createSessionMessageReconciliationState();
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    reconciliationState,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    _lastReconciliationStateRef: reconciliationState,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _fetchSeq: 0,
    _appliedFetchSeq: 0,
    visionBridge: createVisionBridgeSessionState(),
  };
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (
    slot.serverMessages === slot._lastServerRef
    && slot.realtimeMessages === slot._lastRealtimeRef
    && slot.reconciliationState === slot._lastReconciliationStateRef
  ) {
    return false;
  }
  const reconciliation = reconcileAndMergeSessionMessages(
    slot.serverMessages,
    slot.realtimeMessages,
    slot.reconciliationState,
  );
  slot.realtimeMessages = reconciliation.realtimeMessages;
  slot.reconciliationState = reconciliation.state;
  slot.merged = reconciliation.mergedMessages;
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot._lastReconciliationStateRef = slot.reconciliationState;
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────
const STALE_THRESHOLD_MS = 30_000;

/**
 * Extracts vision-bridge messages from a fetched history page, seeds the
 * session's structured observation state (idempotently), and returns the
 * non-vision-bridge messages. Vision-bridge rows are control rows: they
 * reduce into the VB state and never render as standalone messages
 * (design.md D4/D7). contentHash is cache/verification only.
 */
function seedAndStripVisionBridgeMessages(
  slot: SessionSlot,
  sessionId: string,
  messages: NormalizedMessage[],
): NormalizedMessage[] {
  const kept: NormalizedMessage[] = [];
  for (const msg of messages) {
    if (msg.kind === 'vision_bridge') {
      const event = msg.event;
      if (event) {
        const result = applyVisionBridgeEvent(slot.visionBridge, sessionId, event);
        slot.visionBridge = result.state;
      }
      continue;
    }
    kept.push(msg);
  }
  return kept;
}

// ─── Realtime bounds ─────────────────────────────────────────────────────────

const MAX_REALTIME_MESSAGES = 500;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  }, []);

  const has = useCallback((sessionId: string) => {
    return storeRef.current.has(sessionId);
  }, []);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   * The endpoint returns the standard `{ success, data }` envelope.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    const fetchTicket = ++slot._fetchSeq;
    slot.status = 'loading';
    notify(sessionId);

    try {
      const params = new URLSearchParams();
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      const data = body?.data ?? body;
      const messages: NormalizedMessage[] = data.messages || [];

      // A later-started fetch already applied: this response is stale.
      if (fetchTicket <= slot._appliedFetchSeq) {
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

      slot.serverMessages = seedAndStripVisionBridgeMessages(slot, sessionId, messages);
      const reconciliation = reconcileSessionMessages(
        slot.serverMessages,
        slot.realtimeMessages,
        slot.reconciliationState,
      );
      slot.realtimeMessages = reconciliation.realtimeMessages;
      slot.reconciliationState = reconciliation.state;
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      // Don't clobber a newer fetch's result with a stale failure.
      if (fetchTicket > slot._appliedFetchSeq) {
        slot.status = 'error';
        notify(sessionId);
      }
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const fetchTicket = ++slot._fetchSeq;
    const params = new URLSearchParams();
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // A full fetch/refresh replaced serverMessages while this page was in
      // flight — prepending onto the new array would duplicate or misorder.
      if (fetchTicket <= slot._appliedFetchSeq) {
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

      // Prepend older messages (they're earlier in the conversation). Older
      // pages may contain vision-bridge history rows; seed and strip them so
      // the structured card state stays the single source of truth.
      const strippedOlder = seedAndStripVisionBridgeMessages(slot, sessionId, olderMessages);
      slot.serverMessages = [...strippedOlder, ...slot.serverMessages];
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   *
   * `vision_bridge` events are control rows: they reduce into the session's
   * structured observation state (first-terminal-wins, cross-session guarded)
   * and never enter the rendered message list (design.md D4/D7/D11).
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };

    if (normalizedMessage.kind === 'vision_bridge' && normalizedMessage.event) {
      const result = applyVisionBridgeEvent(slot.visionBridge, sessionId, normalizedMessage.event);
      if (result.accepted) {
        slot.visionBridge = result.state;
        notify(sessionId);
      }
      return;
    }

    let updated = upsertRealtimeMessages(
      slot.realtimeMessages,
      [normalizedMessage],
      slot.reconciliationState,
    );
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    retainRealtimeMessageLineage(slot.reconciliationState, updated);
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId },
    );

    // Route vision-bridge control rows into the structured state machine.
    const nonVisionBridge: NormalizedMessage[] = [];
    for (const msg of normalizedMessages) {
      if (msg.kind === 'vision_bridge' && msg.event) {
        const result = applyVisionBridgeEvent(slot.visionBridge, sessionId, msg.event);
        if (result.accepted) {
          slot.visionBridge = result.state;
        }
        continue;
      }
      nonVisionBridge.push(msg);
    }
    if (nonVisionBridge.length === 0) {
      notify(sessionId);
      return;
    }

    let updated = upsertRealtimeMessages(
      slot.realtimeMessages,
      nonVisionBridge,
      slot.reconciliationState,
    );
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    retainRealtimeMessageLineage(slot.reconciliationState, updated);
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-fetch serverMessages from the provider sessions endpoint.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
  ) => {
    const slot = getSlot(sessionId);
    const fetchTicket = ++slot._fetchSeq;
    try {
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;

      // A later-started fetch already applied: applying this stale transcript
      // would erase rows the user has already seen (and re-prune realtime
      // rows against an outdated snapshot).
      if (fetchTicket <= slot._appliedFetchSeq) {
        return;
      }
      slot._appliedFetchSeq = fetchTicket;

      slot.serverMessages = seedAndStripVisionBridgeMessages(
        slot,
        sessionId,
        (data.messages || []) as NormalizedMessage[],
      );
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // Only drop realtime rows the server transcript now owns. A blind clear
      // here caused the chat pane to flash "Continue your conversation" after
      // `complete` while JSONL / provider_session_id indexing was still behind.
      const reconciliation = reconcileSessionMessages(
        slot.serverMessages,
        slot.realtimeMessages,
        slot.reconciliationState,
      );
      slot.realtimeMessages = reconciliation.realtimeMessages;
      slot.reconciliationState = reconciliation.state;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    slot.realtimeMessages = upsertRealtimeMessages(
      slot.realtimeMessages,
      [msg],
      slot.reconciliationState,
    );
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      const finalizedMessageId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: finalizedMessageId,
        kind: 'text',
        role: 'assistant',
      };
      remapRealtimeMessageLineage(
        slot.reconciliationState,
        streamId,
        finalizedMessageId,
      );
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      slot.reconciliationState = createSessionMessageReconciliationState();
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  /**
   * Synthesizes one idempotent `cancelled` terminal for every vision-bridge
   * observation in this session that is still started-but-not-terminal.
   *
   * Called by the realtime handler when the authoritative
   * `complete(aborted:true)` run terminal arrives (design.md D11). The
   * extension's own `cancelled` status is only best-effort and may not arrive
   * after an abort; this guarantees the UI always sees a terminal card.
   */
  const synthesizeVisionBridgeCancellation = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const result = synthesizeCancelledOnAbort(slot.visionBridge, sessionId);
    if (result.events.length > 0) {
      slot.visionBridge = result.state;
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Projects the session's structured vision-bridge observations into render
   * cards grouped by anchor (clientMessageId / toolCallId / sourceEntryId /
   * unbound). The UI attaches cards to the matching user message or tool
   * result, and renders unbound cards once at the session level.
   */
  const getVisionBridgeCards = useCallback((sessionId: string): VisionBridgeCard[] => {
    const slot = storeRef.current.get(sessionId);
    return slot ? projectVisionBridgeCards(slot.visionBridge) : [];
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
    synthesizeVisionBridgeCancellation,
    getVisionBridgeCards,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot,
    synthesizeVisionBridgeCancellation, getVisionBridgeCards,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
