import type { NormalizedMessage } from './useSessionStore';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;
const MAX_CONSUMED_REALTIME_TOMBSTONES = 500;

export type SessionMessageReconciliationState = {
  activeServerUserId: string | null;
  activeMatchedLocalUserTime: number | null;
  serverUserIdByRealtimeMessageId: Map<string, string>;
  claimedServerMessageIds: Set<string>;
  consumedServerMessageIdByRealtimeMessageId: Map<string, string>;
};

export type SessionMessageReconciliationResult = {
  realtimeMessages: NormalizedMessage[];
  state: SessionMessageReconciliationState;
  /**
   * Stable `clientMessageId` values transferred from matched optimistic user
   * messages onto their persisted server user message ids, so the
   * vision-bridge card stays anchored to the surviving bubble after history
   * loads (design.md D7; task 7.5).
   */
  clientMessageIdByServerUserId: Map<string, string>;
};

export type SessionMessageReconciliationMergeResult =
  SessionMessageReconciliationResult & {
    mergedMessages: NormalizedMessage[];
  };

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

type OptimisticUserReconciliation = {
  messages: NormalizedMessage[];
  matchedServerUserIdByLocalId: Map<string, string>;
  clientMessageIdByServerUserId: Map<string, string>;
};

export function createSessionMessageReconciliationState(): SessionMessageReconciliationState {
  return {
    activeServerUserId: null,
    activeMatchedLocalUserTime: null,
    serverUserIdByRealtimeMessageId: new Map<string, string>(),
    claimedServerMessageIds: new Set<string>(),
    consumedServerMessageIdByRealtimeMessageId: new Map<string, string>(),
  };
}

function recordConsumedRealtimeMessage(
  state: SessionMessageReconciliationState,
  realtimeMessageId: string,
  serverMessageId: string,
): void {
  const consumedMessages = state.consumedServerMessageIdByRealtimeMessageId;
  consumedMessages.delete(realtimeMessageId);
  consumedMessages.set(realtimeMessageId, serverMessageId);

  while (consumedMessages.size > MAX_CONSUMED_REALTIME_TOMBSTONES) {
    const oldestRealtimeMessageId = consumedMessages.keys().next().value;
    if (oldestRealtimeMessageId === undefined) {
      break;
    }
    consumedMessages.delete(oldestRealtimeMessageId);
  }
}

function reclaimClaimsFromTombstones(
  state: SessionMessageReconciliationState,
): void {
  state.claimedServerMessageIds = new Set(
    state.consumedServerMessageIdByRealtimeMessageId.values(),
  );
}

function applyReconciliationState(
  target: SessionMessageReconciliationState,
  source: SessionMessageReconciliationState,
): void {
  target.activeServerUserId = source.activeServerUserId;
  target.activeMatchedLocalUserTime = source.activeMatchedLocalUserTime;
  target.serverUserIdByRealtimeMessageId = source.serverUserIdByRealtimeMessageId;
  target.claimedServerMessageIds = source.claimedServerMessageIds;
  target.consumedServerMessageIdByRealtimeMessageId =
    source.consumedServerMessageIdByRealtimeMessageId;
}

function trackIncomingRealtimeMessage(
  state: SessionMessageReconciliationState,
  message: NormalizedMessage,
): void {
  // Assistant, thinking, and stream rows need persisted turn/timestamp context
  // before lineage is assigned. Eagerly inheriting the active user here lets a
  // delayed replay claim the next turn's persisted answer.
  if (message.kind !== 'text' || message.role !== 'user') {
    return;
  }

  state.activeServerUserId = null;
  state.activeMatchedLocalUserTime = null;
  state.serverUserIdByRealtimeMessageId.delete(message.id);
  if (state.serverUserIdByRealtimeMessageId.size === 0) {
    state.claimedServerMessageIds.clear();
    state.consumedServerMessageIdByRealtimeMessageId.clear();
  }
}

export function remapRealtimeMessageLineage(
  state: SessionMessageReconciliationState,
  previousMessageId: string,
  nextMessageId: string,
): void {
  const serverUserId = state.serverUserIdByRealtimeMessageId.get(previousMessageId);
  state.serverUserIdByRealtimeMessageId.delete(previousMessageId);
  if (serverUserId) {
    state.serverUserIdByRealtimeMessageId.set(nextMessageId, serverUserId);
  }

  const consumedServerMessageId =
    state.consumedServerMessageIdByRealtimeMessageId.get(previousMessageId);
  state.consumedServerMessageIdByRealtimeMessageId.delete(previousMessageId);
  if (consumedServerMessageId) {
    recordConsumedRealtimeMessage(state, nextMessageId, consumedServerMessageId);
  }
}

export function retainRealtimeMessageLineage(
  state: SessionMessageReconciliationState,
  realtimeMessages: NormalizedMessage[],
): void {
  const retainedRealtimeMessageIds = new Set(
    realtimeMessages.map((message) => message.id),
  );
  for (const realtimeMessageId of state.serverUserIdByRealtimeMessageId.keys()) {
    if (!retainedRealtimeMessageIds.has(realtimeMessageId)) {
      state.serverUserIdByRealtimeMessageId.delete(realtimeMessageId);
    }
  }
}

/**
 * Applies realtime snapshots by logical message id while preserving their
 * original list position. A lower sequence number is stale replay data and
 * cannot replace a newer snapshot already rendered by the client.
 */
export function upsertRealtimeMessages(
  currentMessages: NormalizedMessage[],
  incomingMessages: NormalizedMessage[],
  state?: SessionMessageReconciliationState,
): NormalizedMessage[] {
  if (incomingMessages.length === 0) {
    return currentMessages;
  }

  const updated = [...currentMessages];
  const indexById = new Map(updated.map((message, index) => [message.id, index]));

  for (const incoming of incomingMessages) {
    const existingIndex = indexById.get(incoming.id);
    if (existingIndex === undefined) {
      indexById.set(incoming.id, updated.length);
      updated.push(incoming);
      if (state) {
        trackIncomingRealtimeMessage(state, incoming);
      }
      continue;
    }

    const existing = updated[existingIndex];
    if (
      typeof existing.seq === 'number'
      && typeof incoming.seq === 'number'
      && incoming.seq < existing.seq
    ) {
      continue;
    }
    updated[existingIndex] = incoming;
    if (state) {
      trackIncomingRealtimeMessage(state, incoming);
    }
  }

  return updated;
}

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function persistedTurnCompletedBefore(
  serverUserMessage: NormalizedMessage,
  localUserTime: number,
  serverMessages: NormalizedMessage[],
): boolean {
  const turnStart = serverMessages.findIndex((message) => message.id === serverUserMessage.id);
  if (turnStart < 0) {
    return false;
  }

  for (let index = turnStart + 1; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      break;
    }

    const messageTime = readMessageTime(message);
    if (messageTime === null || messageTime >= localUserTime || message.isStreaming) {
      continue;
    }

    if (
      (message.kind === 'text' && message.role === 'assistant' && Boolean(message.content?.trim()))
      || (message.kind === 'thinking' && Boolean(message.content?.trim()))
      || message.kind === 'tool_use'
      || message.kind === 'tool_result'
      || message.kind === 'error'
      || message.kind === 'complete'
      || message.kind === 'stream_end'
      || message.kind === 'status'
    ) {
      return true;
    }
  }

  return false;
}

/** Orders persisted and realtime rows by their normalized timestamps. */
export function compareMessagesChronologically(
  first: NormalizedMessage,
  second: NormalizedMessage,
): number {
  const firstTime = readMessageTime(first);
  const secondTime = readMessageTime(second);
  if (firstTime === null && secondTime === null) {
    return 0;
  }
  if (firstTime === null) {
    return 1;
  }
  if (secondTime === null) {
    return -1;
  }
  if (firstTime !== secondTime) {
    return firstTime - secondTime;
  }
  return 0;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localTime = readMessageTime(localMessage);
  if (localTime === null) {
    return null;
  }

  // 7.5: prefer a stable clientMessageId match over the text/image/file
  // fingerprint. The server validates (or generates) clientMessageId, so when
  // the persisted user message echoes it, that identity is authoritative even
  // if the provider normalized whitespace or image representation.
  const localClientMessageId =
    typeof localMessage.clientMessageId === 'string' && localMessage.clientMessageId;
  if (localClientMessageId) {
    const candidates: NormalizedMessage[] = [];
    for (const serverMessage of serverMessages) {
      if (claimedServerIds.has(serverMessage.id)) {
        continue;
      }
      if (serverMessage.kind !== 'text' || serverMessage.role !== 'user') {
        continue;
      }
      if (
        typeof serverMessage.clientMessageId !== 'string'
        || serverMessage.clientMessageId !== localClientMessageId
      ) {
        continue;
      }
      const serverTime = readMessageTime(serverMessage);
      if (
        serverTime === null
        || serverTime < localTime
        || serverTime - localTime > LOCAL_USER_DEDUPE_WINDOW_MS
      ) {
 continue; }
      candidates.push(serverMessage);
    }
    // A unique clientMessageId echo wins; an ambiguous echo falls back to the
    // fingerprint matcher rather than guessing the nearest message.
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      return null;
    }
    // No clientMessageId echo: fall through to the fingerprint path.
  }

  const localFingerprint = userTurnFingerprint(localMessage);
  if (!localFingerprint) {
    return null;
  }

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let eligibleMatch: NormalizedMessage | null = null;

  for (const serverMessage of serverMessages) {
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    // A completed response predating the local action proves this is an older turn.
    if (
      serverTime === null
      || serverTime < localTime
      || serverTime - localTime > dedupeWindow
      || persistedTurnCompletedBefore(serverMessage, localTime, serverMessages)
    ) {
      continue;
    }

    if (eligibleMatch) {
      return null;
    }
    eligibleMatch = serverMessage;
  }

  return eligibleMatch;
}

/**
 * Removes local optimistic user rows once a corresponding persisted turn is
 * available. Matches are one-to-one so repeated sends cannot claim one row.
 */
function reconcileOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): OptimisticUserReconciliation {
  const claimedServerIds = new Set<string>();
  const matchedServerUserIdByLocalId = new Map<string, string>();
  const clientMessageIdByServerUserId = new Map<string, string>();

  const messages = realtimeMessages.filter((message) => {
    if (!message.id.startsWith('local_')) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    matchedServerUserIdByLocalId.set(message.id, serverEcho.id);
    if (typeof message.clientMessageId === 'string' && message.clientMessageId) {
      clientMessageIdByServerUserId.set(serverEcho.id, message.clientMessageId);
    }
    return false;
  });

  return { messages, matchedServerUserIdByLocalId, clientMessageIdByServerUserId };
}

export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  return reconcileOptimisticUserEchoes(serverMessages, realtimeMessages).messages;
}

function findServerTurnRangeByUserId(
  serverMessages: NormalizedMessage[],
  serverUserId: string,
): { start: number; end: number } | null {
  const start = serverMessages.findIndex((message) =>
    message.id === serverUserId
    && message.kind === 'text'
    && message.role === 'user',
  );
  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

/**
 * A retained/active lineage is usable only when the realtime row is not older
 * than the persisted user that owns the turn. Older rows can be delayed
 * replays from a previous turn and must stay unanchored so the timestamped
 * matcher can reject future-turn echoes.
 */
function isRealtimeMessageAtOrAfterServerUser(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  serverUserId: string,
): boolean {
  const serverUser = serverMessages.find((candidate) =>
    candidate.id === serverUserId
    && candidate.kind === 'text'
    && candidate.role === 'user',
  );
  if (!serverUser) {
    // A history snapshot may not contain the user yet (for example while a
    // stream is being hydrated). In that case the existing active lineage is
    // the only available anchor and remains usable.
    return true;
  }

  const messageTime = readMessageTime(message);
  const serverUserTime = readMessageTime(serverUser);
  return messageTime === null || serverUserTime === null || messageTime >= serverUserTime;
}

function isRealtimeMessageAtOrAfterMatchedLocalUser(
  message: NormalizedMessage,
  serverUserId: string,
  matchedLocalTimeByServerUserId: Map<string, number | null>,
): boolean {
  const localTime = matchedLocalTimeByServerUserId.get(serverUserId);
  if (localTime === undefined) {
    return false;
  }
  const messageTime = readMessageTime(message);
  return localTime === null || messageTime === null || messageTime >= localTime;
}

function isRealtimeMessageAtOrAfterActiveMatchedLocalUser(
  message: NormalizedMessage,
  serverUserId: string,
  state: SessionMessageReconciliationState,
): boolean {
  if (
    state.activeServerUserId !== serverUserId
    || state.activeMatchedLocalUserTime === null
  ) {
    return false;
  }
  const messageTime = readMessageTime(message);
  return messageTime !== null && messageTime >= state.activeMatchedLocalUserTime;
}

/**
 * Infers a persisted turn for a terminal realtime assistant row when the
 * realtime snapshot does not include a local user row or retained lineage.
 * Only a unique, chronologically compatible assistant echo is eligible; an
 * ambiguous or already-completed older turn is left visible.
 */
function findUnanchoredAssistantEcho(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  state: SessionMessageReconciliationState,
): NormalizedMessage | null {
  const realtimeTime = readMessageTime(message);
  const assistantText = (message.content || '').trim();
  if (realtimeTime === null || !assistantText) {
    return null;
  }

  let currentServerUserId: string | null = null;
  const candidates: NormalizedMessage[] = [];

  for (const serverMessage of serverMessages) {
    if (serverMessage.kind === 'text' && serverMessage.role === 'user') {
      const serverUserTime = readMessageTime(serverMessage);
      if (serverUserTime === null || serverUserTime > realtimeTime) {
        // An invalid or later persisted user is an unresolvable turn boundary.
        // Rows after it cannot be inferred as echoes for this realtime row.
        break;
      }
      currentServerUserId = serverMessage.id;
      continue;
    }

    if (
      !currentServerUserId
      || state.claimedServerMessageIds.has(serverMessage.id)
      || serverMessage.kind !== 'text'
      || serverMessage.role !== 'assistant'
      || (serverMessage.content || '').trim() !== assistantText
    ) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (serverTime !== null && serverTime >= realtimeTime) {
      candidates.push(serverMessage);
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function mapRealtimeMessagesToServerUser(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  matchedServerUserIdByLocalId: Map<string, string>,
  serverIds: Set<string>,
  state: SessionMessageReconciliationState,
  latestServerUserId: string | null,
): Map<string, string | null> {
  const serverUserIdByRealtimeMessageId = new Map<string, string | null>();
  let currentServerUserId: string | null | undefined =
    state.activeServerUserId ?? undefined;
  const matchedLocalTimeByServerUserId = new Map<string, number | null>();
  for (const message of realtimeMessages) {
    if (message.kind !== 'text' || message.role !== 'user' || !message.id.startsWith('local_')) {
      continue;
    }
    const matchedServerUserId = matchedServerUserIdByLocalId.get(message.id);
    if (matchedServerUserId) {
      matchedLocalTimeByServerUserId.set(matchedServerUserId, readMessageTime(message));
    }
  }

  // Realtime rows can be appended in transport arrival order (a replay may
  // arrive after a newer local turn), while lineage is a temporal relation.
  // Walk a stable chronological view for mapping but keep the caller's list
  // order untouched for rendering and filtering.
  const orderedMessages = realtimeMessages
    .map((message, index) => ({ message, index }))
    .sort((first, second) =>
      compareMessagesChronologically(first.message, second.message) || first.index - second.index,
    );

  for (const { message } of orderedMessages) {
    if (message.kind === 'text' && message.role === 'user') {
      if (message.id.startsWith('local_')) {
        currentServerUserId = matchedServerUserIdByLocalId.get(message.id) ?? null;
        state.activeMatchedLocalUserTime = currentServerUserId
          ? readMessageTime(message)
          : null;
      } else {
        currentServerUserId = serverIds.has(message.id) ? message.id : null;
        state.activeMatchedLocalUserTime = null;
      }
      state.activeServerUserId = currentServerUserId;
      state.serverUserIdByRealtimeMessageId.delete(message.id);
      continue;
    }

    const retainedServerUserId = state.serverUserIdByRealtimeMessageId.get(message.id);
    if (retainedServerUserId) {
      const retainedLineageIsCurrent =
        (!latestServerUserId
        || retainedServerUserId === latestServerUserId
        || currentServerUserId === retainedServerUserId);
      if (retainedLineageIsCurrent) {
        serverUserIdByRealtimeMessageId.set(message.id, retainedServerUserId);
        currentServerUserId = retainedServerUserId;
        if (state.activeServerUserId !== retainedServerUserId) {
          state.activeMatchedLocalUserTime = null;
        }
        state.activeServerUserId = retainedServerUserId;
      }
      continue;
    }

    if (currentServerUserId !== undefined) {
      if (
        currentServerUserId === null
        || isRealtimeMessageAtOrAfterServerUser(message, serverMessages, currentServerUserId)
        || isRealtimeMessageAtOrAfterMatchedLocalUser(
          message,
          currentServerUserId,
          matchedLocalTimeByServerUserId,
        )
        || isRealtimeMessageAtOrAfterActiveMatchedLocalUser(
          message,
          currentServerUserId,
          state,
        )
      ) {
        serverUserIdByRealtimeMessageId.set(message.id, currentServerUserId);
        if (currentServerUserId) {
          state.serverUserIdByRealtimeMessageId.set(message.id, currentServerUserId);
          if (state.activeServerUserId !== currentServerUserId) {
            state.activeMatchedLocalUserTime = null;
          }
          state.activeServerUserId = currentServerUserId;
        }
      }
    }
  }

  return serverUserIdByRealtimeMessageId;
}

function latestPersistedUserId(messages: NormalizedMessage[]): string | null {
  let latestId: string | null = null;
  let latestTime: number | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.kind === 'text' && message.role === 'user') {
      const messageTime = readMessageTime(message);
      if (latestId === null) {
        latestId = message.id;
        latestTime = messageTime;
        continue;
      }
      if (
        messageTime !== null
        // An invalid timestamp on the structural latest user is still a
        // turn boundary; do not let an older valid user keep stale lineage.
        && latestTime !== null
        && messageTime > latestTime
      ) {
        latestId = message.id;
        latestTime = messageTime;
      }
    }
  }
  return latestId;
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  anchoredServerUserId: string | null | undefined,
  state: SessionMessageReconciliationState,
  allowUnanchoredInference = true,
): boolean {
  if (
    message.isStreaming
    || message.id === `__streaming_${message.sessionId}`
    || readMessageTime(message) === null
  ) {
    return false;
  }

  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  if (anchoredServerUserId === null || anchoredServerUserId === undefined) {
    if (!allowUnanchoredInference) {
      return false;
    }
    const inferredServerEcho = findUnanchoredAssistantEcho(message, serverMessages, state);
    if (!inferredServerEcho) {
      return false;
    }
    state.claimedServerMessageIds.add(inferredServerEcho.id);
    recordConsumedRealtimeMessage(state, message.id, inferredServerEcho.id);
    return true;
  }

  const turnRange = findServerTurnRangeByUserId(serverMessages, anchoredServerUserId);
  if (!turnRange) {
    return false;
  }

  const serverEcho = serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .find((serverMessage) =>
      !state.claimedServerMessageIds.has(serverMessage.id)
      && serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
  if (!serverEcho) {
    return false;
  }

  state.claimedServerMessageIds.add(serverEcho.id);
  recordConsumedRealtimeMessage(state, message.id, serverEcho.id);
  return true;
}

function isThinkingEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  anchoredServerUserId: string | null | undefined,
  state: SessionMessageReconciliationState,
): boolean {
  if (message.isStreaming || readMessageTime(message) === null) {
    return false;
  }

  const thinkingContent = (message.content || '').trim();
  if (!thinkingContent) {
    return false;
  }

  if (anchoredServerUserId === null || anchoredServerUserId === undefined) {
    return false;
  }

  const turnRange = findServerTurnRangeByUserId(serverMessages, anchoredServerUserId);
  if (!turnRange) {
    return false;
  }

  const serverEcho = serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .find((serverMessage) =>
      !state.claimedServerMessageIds.has(serverMessage.id)
      && serverMessage.kind === 'thinking'
      && (serverMessage.content || '').trim() === thinkingContent,
    );
  if (!serverEcho) {
    return false;
  }

  state.claimedServerMessageIds.add(serverEcho.id);
  recordConsumedRealtimeMessage(state, message.id, serverEcho.id);
  return true;
}

function cloneReconciliationState(
  state: SessionMessageReconciliationState,
): SessionMessageReconciliationState {
  return {
    activeServerUserId: state.activeServerUserId,
    activeMatchedLocalUserTime: state.activeMatchedLocalUserTime,
    serverUserIdByRealtimeMessageId: new Map(state.serverUserIdByRealtimeMessageId),
    claimedServerMessageIds: new Set(state.claimedServerMessageIds),
    consumedServerMessageIdByRealtimeMessageId: new Map(
      state.consumedServerMessageIdByRealtimeMessageId,
    ),
  };
}

export function reconcileSessionMessages(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  currentState: SessionMessageReconciliationState = createSessionMessageReconciliationState(),
): SessionMessageReconciliationResult {
  const state = cloneReconciliationState(currentState);
  reclaimClaimsFromTombstones(state);
  if (realtimeMessages.length === 0) {
    return { realtimeMessages, state, clientMessageIdByServerUserId: new Map() };
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const optimisticUserReconciliation = reconcileOptimisticUserEchoes(
    serverMessages,
    realtimeMessages,
  );
  const reconciledRealtimeMessages = optimisticUserReconciliation.messages;
  // A completed turn can leave its active lineage behind after all of its
  // realtime rows were consumed. If the persisted snapshot has advanced to a
  // newer user turn and this snapshot contains no user anchor, do not attach a
  // new raw stream to that stale turn; let the timestamped unanchored matcher
  // select the unique assistant echo instead.
  const latestUserId = latestPersistedUserId(serverMessages);
  const hasRealtimeUserAnchor = reconciledRealtimeMessages.some(
    (message) => message.kind === 'text' && message.role === 'user',
  );
  const hasInvalidPersistedUserTimestamp = serverMessages.some(
    (message) =>
      message.kind === 'text'
      && message.role === 'user'
      && readMessageTime(message) === null,
  );
  const latestUser = latestUserId
    ? serverMessages.find((message) => message.id === latestUserId)
    : undefined;
  const latestUserTime = latestUser ? readMessageTime(latestUser) : null;
  // A matched local turn remains authoritative while its realtime rows are
  // still earlier than a timestamp-max user from a clock-rolled-back history.
  // Once a row reaches that user's timestamp, the retained lineage is stale.
  const hasRealtimeMessageAtOrAfterLatestUser = latestUserTime === null
    || reconciledRealtimeMessages.some((message) => {
      if (message.kind === 'text' && message.role === 'user') {
        return false;
      }
      const messageTime = readMessageTime(message);
      return messageTime !== null && messageTime >= latestUserTime;
    });
  if (
    !hasRealtimeUserAnchor
    && state.activeServerUserId
    && latestUserId
    && latestUserId !== state.activeServerUserId
    && (
      state.activeMatchedLocalUserTime === null
      || hasInvalidPersistedUserTimestamp
      || hasRealtimeMessageAtOrAfterLatestUser
    )
  ) {
    state.activeServerUserId = null;
    state.activeMatchedLocalUserTime = null;
  }
  const serverUserIdByRealtimeMessageId = mapRealtimeMessagesToServerUser(
    serverMessages,
    realtimeMessages,
    optimisticUserReconciliation.matchedServerUserIdByLocalId,
    serverIds,
    state,
    latestUserId,
  );
  const claimedServerMessageIds = state.claimedServerMessageIds;
  const consumedServerMessageIdByRealtimeMessageId =
    state.consumedServerMessageIdByRealtimeMessageId;

  const remainingRealtimeMessages = reconciledRealtimeMessages.filter((message) => {
    if (consumedServerMessageIdByRealtimeMessageId.has(message.id)) {
      return false;
    }

    if (serverIds.has(message.id)) {
      claimedServerMessageIds.add(message.id);
      recordConsumedRealtimeMessage(state, message.id, message.id);
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      const hasExplicitLineage = serverUserIdByRealtimeMessageId.has(message.id);
      if (isAssistantTextEchoedInSameTurnOnServer(
        message,
        serverMessages,
        serverUserIdByRealtimeMessageId.get(message.id),
        state,
        !hasExplicitLineage,
      )) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      const hasExplicitLineage = serverUserIdByRealtimeMessageId.has(message.id);
      if (isAssistantTextEchoedInSameTurnOnServer(
        message,
        serverMessages,
        serverUserIdByRealtimeMessageId.get(message.id),
        state,
        !hasExplicitLineage,
      )) {
        return false;
      }
      return true;
    }

    if (message.kind === 'thinking') {
      if (isThinkingEchoedInSameTurnOnServer(
        message,
        serverMessages,
        serverUserIdByRealtimeMessageId.get(message.id),
        state,
      )) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });

  retainRealtimeMessageLineage(state, remainingRealtimeMessages);
  reclaimClaimsFromTombstones(state);

  return {
    realtimeMessages: remainingRealtimeMessages,
    state,
    clientMessageIdByServerUserId: optimisticUserReconciliation.clientMessageIdByServerUserId,
  };
}

/**
 * Keeps only realtime rows not yet represented by the latest persisted
 * transcript, preserving unfinished streams while history indexing catches up.
 */
export function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  state?: SessionMessageReconciliationState,
): NormalizedMessage[] {
  const result = reconcileSessionMessages(serverMessages, realtimeMessages, state);
  if (state) {
    applyReconciliationState(state, result.state);
  }
  return result.realtimeMessages;
}

function combineReconciledSessionMessages(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  clientMessageIdByServerUserId: Map<string, string> = new Map(),
): NormalizedMessage[] {
  // Transfer the stable clientMessageId from a matched optimistic user echo
  // onto its persisted server user message so the vision-bridge card stays
  // anchored to the surviving bubble (design.md D7; task 7.5).
  const serverWithClientId = clientMessageIdByServerUserId.size > 0
    ? serverMessages.map((message) => {
        const clientId = clientMessageIdByServerUserId.get(message.id);
        if (
          clientId
          && message.kind === 'text'
          && message.role === 'user'
          && typeof message.clientMessageId !== 'string'
        ) {
          return { ...message, clientMessageId: clientId };
        }
        return message;
      })
    : serverMessages;

  if (realtimeMessages.length === 0) {
    return serverWithClientId;
  }
  if (serverWithClientId.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverWithClientId.map((message) => message.id));
  const extraMessages = realtimeMessages.filter(
    (message) => !serverIds.has(message.id),
  );

  if (extraMessages.length === 0) {
    return serverWithClientId;
  }

  return [...serverWithClientId, ...extraMessages].sort(compareMessagesChronologically);
}

/** Reconciles and merges persisted/realtime rows in one pass for the store. */
export function reconcileAndMergeSessionMessages(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  state?: SessionMessageReconciliationState,
): SessionMessageReconciliationMergeResult {
  const reconciliation = reconcileSessionMessages(
    serverMessages,
    realtimeMessages,
    state,
  );
  return {
    ...reconciliation,
    mergedMessages: combineReconciledSessionMessages(
      serverMessages,
      reconciliation.realtimeMessages,
      reconciliation.clientMessageIdByServerUserId,
    ),
  };
}

/** Merges persisted and realtime rows for the session store's rendered view. */
export function mergeSessionMessages(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  state?: SessionMessageReconciliationState,
): NormalizedMessage[] {
  const result = reconcileAndMergeSessionMessages(
    serverMessages,
    realtimeMessages,
    state,
  );
  if (state) {
    applyReconciliationState(state, result.state);
  }
  return result.mergedMessages;
}
