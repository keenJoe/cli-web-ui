/**
 * Pure, testable vision-bridge state machine for one chat session.
 *
 * The backend (group 5) emits `kind: "vision_bridge"` ProviderRunEvents that
 * carry a server-validated `VisionBridgeRunEventV1` on the message `event`
 * field, plus flattened identity (`runId`/`appSessionId`/`observationId`/
 * `phase`/`source`/`imageIndex`/`contentHash`, and `clientMessageId` when the
 * source is a user message). The authoritative run terminal is the existing
 * `complete(aborted:true)` event; the extension's own `cancelled` status is
 * only best-effort (design.md D11).
 *
 * This module owns the rules that are awkward to express in the message list:
 * - First terminal phase wins; any later phase (including a replayed started
 *   or a late success) is rejected.
 * - On `complete(aborted:true)` the store synthesizes one idempotent
 *   `cancelled` terminal for every started-but-not-terminal observation in
 *   the aborted session, so the UI always sees a terminal card.
 * - `contentHash` is content/cache verification only; observation identity is
 *   `appSessionId + runId + observationId`, so the same image in another
 *   session cannot modify this session's card (design.md D7).
 *
 * The state is plain data and the functions are pure (return new state), so it
 * is unit-testable without React or the websocket transport.
 */
import type {
  VisionBridgeImageErrorCode,
  VisionBridgeRunEventV1,
  VisionBridgeRunPhase,
  VisionBridgeRunSource,
} from '../../shared/vision-bridge';

/** Terminal phases a started observation may settle into. */
export type VisionBridgeTerminalPhase = 'succeeded' | 'failed' | 'skipped' | 'cancelled';

const TERMINAL_PHASES: ReadonlySet<VisionBridgeTerminalPhase> = new Set([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);

/** Stable identity of one image position within a session/run. */
function observationKey(runId: string, observationId: string): string {
  return `${runId}:${observationId}`;
}

/** One image observation's latest accepted state. */
export interface VisionBridgeObservationState {
  observationId: string;
  runId: string;
  appSessionId: string;
  phase: VisionBridgeRunPhase;
  source: VisionBridgeRunSource;
  imageIndex: number;
  contentHash: string;
  /** Latest accepted event payload (carries description/error/duration/cached). */
  event: VisionBridgeRunEventV1;
  /** True once a terminal phase has been accepted. */
  terminal: boolean;
}

/** Per-session vision-bridge state. Plain data; never mutated in place. */
export interface VisionBridgeSessionState {
  observations: Map<string, VisionBridgeObservationState>;
}

export function createVisionBridgeSessionState(): VisionBridgeSessionState {
  return { observations: new Map() };
}

function cloneState(state: VisionBridgeSessionState): VisionBridgeSessionState {
  return { observations: new Map(state.observations) };
}

/**
 * Applies one realtime vision-bridge event to the session state.
 *
 * Returns `{ accepted: false }` (leaving state unchanged) when the event is
 * for a different app session (cross-session isolation), or when the
 * observation has already reached a terminal phase (first terminal wins;
 * late started/success after terminal rejected). Otherwise it records the
 * latest phase and marks terminal when applicable.
 */
export function applyVisionBridgeEvent(
  state: VisionBridgeSessionState,
  sessionAppSessionId: string,
  event: VisionBridgeRunEventV1,
): { state: VisionBridgeSessionState; accepted: boolean } {
  // Cross-session guard: an event for another session (same image or not)
  // must not modify this session's card (D7).
  if (event.appSessionId !== sessionAppSessionId) {
    return { state, accepted: false };
  }

  const key = observationKey(event.runId, event.observationId);
  const existing = state.observations.get(key);
  if (existing?.terminal) {
    return { state, accepted: false };
  }

  const terminal = TERMINAL_PHASES.has(event.phase as VisionBridgeTerminalPhase);
  const next: VisionBridgeObservationState = {
    observationId: event.observationId,
    runId: event.runId,
    appSessionId: event.appSessionId,
    phase: event.phase,
    source: event.source,
    imageIndex: event.imageIndex,
    contentHash: event.contentHash,
    event,
    terminal,
  };
  const cloned = cloneState(state);
  cloned.observations.set(key, next);
  return { state: cloned, accepted: true };
}

/**
 * Synthesizes one idempotent `cancelled` terminal for every observation in the
 * session that is still non-terminal (i.e. started but not settled). Called by
 * the store when the authoritative `complete(aborted:true)` run terminal
 * arrives (design.md D11). The synthesized events are returned so the store
 * can append them as realtime `vision_bridge` messages.
 *
 * Idempotent: a second call returns no events because every observation is now
 * terminal.
 */
export function synthesizeCancelledOnAbort(
  state: VisionBridgeSessionState,
  sessionAppSessionId: string,
): { state: VisionBridgeSessionState; events: VisionBridgeRunEventV1[] } {
  const events: VisionBridgeRunEventV1[] = [];
  const cloned = cloneState(state);

  for (const [key, obs] of cloned.observations) {
    if (obs.terminal) continue;
    if (obs.appSessionId !== sessionAppSessionId) continue;

    const cancelled: VisionBridgeRunEventV1 = {
      ...obs.event,
      // Deterministic synthetic id so a repeated abort does not duplicate.
      eventId: `vb:cancelled:${obs.runId}:${obs.observationId}`,
      phase: 'cancelled',
      errorCode: 'VISION_CANCELLED' as VisionBridgeImageErrorCode,
      errorMessage: '',
      // A cancelled observation has no successful description.
      description: undefined,
    };
    events.push(cancelled);
    cloned.observations.set(key, {
      ...obs,
      phase: 'cancelled',
      terminal: true,
      event: cancelled,
    });
  }

  return { state: cloned, events };
}

/** Anchor a card is attached to (or `unbound` for session-level cards). */
export type VisionBridgeCardAnchor =
  | { kind: 'user'; clientMessageId: string }
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'history'; sourceEntryId: string }
  | { kind: 'unbound' };

/** One image result projected onto a card. */
export interface VisionBridgeCardItem {
  observationId: string;
  imageIndex: number;
  phase: VisionBridgeRunPhase;
  description?: string;
  errorCode?: string;
  errorMessage?: string;
  contentHash: string;
  cached: boolean;
}

/** A structured vision-bridge card, grouped by anchor. */
export interface VisionBridgeCard {
  anchor: VisionBridgeCardAnchor;
  items: VisionBridgeCardItem[];
}

function anchorKeyValue(anchor: VisionBridgeCardAnchor): string {
  if (anchor.kind === 'user') return `user:${anchor.clientMessageId}`;
  if (anchor.kind === 'tool') return `tool:${anchor.toolCallId}`;
  if (anchor.kind === 'history') return `history:${anchor.sourceEntryId}`;
  return 'unbound';
}

function deriveAnchor(source: VisionBridgeRunSource): VisionBridgeCardAnchor {
  if (source.kind === 'user') {
    if (typeof source.clientMessageId === 'string' && source.clientMessageId) {
      return { kind: 'user', clientMessageId: source.clientMessageId };
    }
    if (typeof source.sourceEntryId === 'string' && source.sourceEntryId) {
      return { kind: 'history', sourceEntryId: source.sourceEntryId };
    }
    return { kind: 'unbound' };
  }
  if (source.kind === 'tool') {
    return { kind: 'tool', toolCallId: source.toolCallId };
  }
  // history
  return { kind: 'history', sourceEntryId: source.sourceEntryId };
}

function toCardItem(obs: VisionBridgeObservationState): VisionBridgeCardItem {
  return {
    observationId: obs.observationId,
    imageIndex: obs.imageIndex,
    phase: obs.phase,
    ...(typeof obs.event.description === 'string' ? { description: obs.event.description } : {}),
    ...(typeof obs.event.errorCode === 'string' ? { errorCode: obs.event.errorCode } : {}),
    ...(typeof obs.event.errorMessage === 'string' ? { errorMessage: obs.event.errorMessage } : {}),
    contentHash: obs.contentHash,
    cached: obs.event.cached,
  };
}

/**
 * Projects the current observation state into renderable cards grouped by
 * anchor. Items within a card are ordered by `imageIndex`. Each observation
 * contributes exactly one item (its latest accepted phase).
 */
export function projectVisionBridgeCards(
  state: VisionBridgeSessionState,
): VisionBridgeCard[] {
  const buckets = new Map<string, { anchor: VisionBridgeCardAnchor; items: VisionBridgeCardItem[] }>();

  for (const obs of state.observations.values()) {
    const anchor = deriveAnchor(obs.source);
    const key = anchorKeyValue(anchor);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { anchor, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(toCardItem(obs));
  }

  const cards: VisionBridgeCard[] = [];
  for (const bucket of buckets.values()) {
    bucket.items.sort((a, b) => a.imageIndex - b.imageIndex);
    cards.push({ anchor: bucket.anchor, items: bucket.items });
  }
  return cards;
}

/**
 * Returns the cards anchored to a specific user `clientMessageId`. Used by the
 * user-message renderer to attach vision-bridge cards next to the originating
 * bubble.
 */
export function cardsForClientMessageId(
  state: VisionBridgeSessionState,
  clientMessageId: string,
): VisionBridgeCard[] {
  return projectVisionBridgeCards(state).filter(
    (card) => card.anchor.kind === 'user' && card.anchor.clientMessageId === clientMessageId,
  );
}

/**
 * Returns the cards anchored to a specific `toolCallId`. Used by the tool-result
 * renderer to attach vision-bridge cards next to the originating tool call.
 */
export function cardsForToolCallId(
  state: VisionBridgeSessionState,
  toolCallId: string,
): VisionBridgeCard[] {
  return projectVisionBridgeCards(state).filter(
    (card) => card.anchor.kind === 'tool' && card.anchor.toolCallId === toolCallId,
  );
}

/**
 * Returns the session-level "unbound source" cards (history results without a
 * unique anchor). Rendered once per session, not next to any message.
 */
export function unboundVisionBridgeCards(
  state: VisionBridgeSessionState,
): VisionBridgeCard[] {
  return projectVisionBridgeCards(state).filter((card) => card.anchor.kind === 'unbound');
}
