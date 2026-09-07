import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { VisionBridgeRunEventV1 } from '../../shared/vision-bridge';

import {
  applyVisionBridgeEvent,
  createVisionBridgeSessionState,
  projectVisionBridgeCards,
  synthesizeCancelledOnAbort,
} from './visionBridgeState';

const HASH = 'a'.repeat(64);

function buildEvent(overrides: Partial<VisionBridgeRunEventV1>): VisionBridgeRunEventV1 {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    batchId: 'batch-1',
    observationId: 'obs-1',
    phase: 'started',
    source: { kind: 'user', clientMessageId: 'cm-1' },
    runId: 'run-1',
    appSessionId: 'session-A',
    imageIndex: 1,
    contentHash: HASH,
    cached: false,
    ...overrides,
  };
}

test('started then succeeded is accepted and becomes terminal', () => {
  const state = createVisionBridgeSessionState();
  const started = buildEvent({ phase: 'started' });
  const r1 = applyVisionBridgeEvent(state, 'session-A', started);
  assert.equal(r1.accepted, true);
  assert.equal(r1.state.observations.size, 1);
  const [obs] = [...r1.state.observations.values()];
  assert.equal(obs.phase, 'started');
  assert.equal(obs.terminal, false);

  const r2 = applyVisionBridgeEvent(r1.state, 'session-A', buildEvent({
    eventId: 'evt-2',
    phase: 'succeeded',
    description: 'a cat',
  }));
  assert.equal(r2.accepted, true);
  const [obs2] = [...r2.state.observations.values()];
  assert.equal(obs2.phase, 'succeeded');
  assert.equal(obs2.terminal, true);
});

test('failed, skipped and cancelled terminal phases are all accepted', () => {
  for (const phase of ['failed', 'skipped', 'cancelled'] as const) {
    const state = createVisionBridgeSessionState();
    applyVisionBridgeEvent(state, 'session-A', buildEvent({ phase: 'started' }));
    const r = applyVisionBridgeEvent(state, 'session-A', buildEvent({
      eventId: `evt-${phase}`,
      phase,
      errorCode: 'VISION_TIMEOUT',
    }));
    assert.equal(r.accepted, true);
    const [obs] = [...r.state.observations.values()];
    assert.equal(obs.phase, phase);
    assert.equal(obs.terminal, true);
  }
});

test('an event from a different app session does not modify the current session state', () => {
  const state = createVisionBridgeSessionState();
  const event = buildEvent({ appSessionId: 'session-B' });
  const r = applyVisionBridgeEvent(state, 'session-A', event);
  assert.equal(r.accepted, false);
  assert.equal(r.state.observations.size, 0);
});

test('terminal replay is idempotent: a second terminal is rejected', () => {
  const state = createVisionBridgeSessionState();
  applyVisionBridgeEvent(state, 'session-A', buildEvent({ phase: 'started' }));
  const r1 = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-success',
    phase: 'succeeded',
    description: 'a cat',
  }));
  assert.equal(r1.accepted, true);
  const r2 = applyVisionBridgeEvent(r1.state, 'session-A', buildEvent({
    eventId: 'evt-success-replay',
    phase: 'succeeded',
    description: 'a different cat',
  }));
  assert.equal(r2.accepted, false);
  const [obs] = [...r2.state.observations.values()];
  assert.equal(obs.phase, 'succeeded');
  assert.equal(obs.event.description, 'a cat');
});

test('after cancellation, a late succeeded is rejected', () => {
  const state = createVisionBridgeSessionState();
  applyVisionBridgeEvent(state, 'session-A', buildEvent({ phase: 'started' }));
  const cancelled = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-cancelled',
    phase: 'cancelled',
    errorCode: 'VISION_CANCELLED',
  }));
  assert.equal(cancelled.accepted, true);

  const lateSuccess = applyVisionBridgeEvent(cancelled.state, 'session-A', buildEvent({
    eventId: 'evt-late-success',
    phase: 'succeeded',
    description: 'a cat',
  }));
  assert.equal(lateSuccess.accepted, false);
  const [obs] = [...lateSuccess.state.observations.values()];
  assert.equal(obs.phase, 'cancelled');
});

test('a late started arriving after a terminal is rejected', () => {
  let state = createVisionBridgeSessionState();
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({ phase: 'started' })).state;
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-success',
    phase: 'succeeded',
    description: 'a cat',
  })).state;
  const lateStarted = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-late-started',
    phase: 'started',
  }));
  assert.equal(lateStarted.accepted, false);
});

test('synthesizeCancelledOnAbort cancels started-but-not-terminal observations for the session', () => {
  let state = createVisionBridgeSessionState();
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    observationId: 'obs-1',
    phase: 'started',
  })).state;
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-2',
    observationId: 'obs-2',
    phase: 'started',
  })).state;
  // obs-3 already terminal
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-3',
    observationId: 'obs-3',
    phase: 'started',
  })).state;
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-3-success',
    observationId: 'obs-3',
    phase: 'succeeded',
    description: 'done',
  })).state;

  const r = synthesizeCancelledOnAbort(state, 'session-A');
  assert.equal(r.events.length, 2);
  for (const event of r.events) {
    assert.equal(event.phase, 'cancelled');
    assert.equal(event.errorCode, 'VISION_CANCELLED');
    assert.equal(event.appSessionId, 'session-A');
  }
  // All observations are now terminal.
  for (const obs of r.state.observations.values()) {
    assert.equal(obs.terminal, true);
  }
  // Idempotent: a second abort synthesizes nothing.
  const r2 = synthesizeCancelledOnAbort(r.state, 'session-A');
  assert.equal(r2.events.length, 0);
});

test('history terminal item replayed via apply is idempotent and rejects late success', () => {
  const state = createVisionBridgeSessionState();
  const r1 = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    observationId: 'hist-1',
    runId: 'run-hist',
    eventId: 'evt-hist',
    phase: 'succeeded',
    description: 'a dog',
    source: { kind: 'user', clientMessageId: 'cm-hist' },
    imageIndex: 1,
  }));
  assert.equal(r1.state.observations.size, 1);
  const [obs] = [...r1.state.observations.values()];
  assert.equal(obs.phase, 'succeeded');
  assert.equal(obs.terminal, true);

  // Replaying the same terminal is rejected (idempotent).
  const r2 = applyVisionBridgeEvent(r1.state, 'session-A', buildEvent({
    observationId: 'hist-1',
    runId: 'run-hist',
    eventId: 'evt-hist-2',
    phase: 'succeeded',
    description: 'a different dog',
    source: { kind: 'user', clientMessageId: 'cm-hist' },
    imageIndex: 1,
  }));
  assert.equal(r2.accepted, false);
  assert.equal(r2.state.observations.size, 1);
});

test('projectVisionBridgeCards groups items by anchor and orders by imageIndex', () => {
  let state = createVisionBridgeSessionState();
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    observationId: 'obs-1',
    imageIndex: 2,
    phase: 'started',
  })).state;
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-1-s',
    observationId: 'obs-1',
    imageIndex: 2,
    phase: 'succeeded',
    description: 'second image',
  })).state;
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-2',
    observationId: 'obs-2',
    imageIndex: 1,
    phase: 'started',
  })).state;
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-2-s',
    observationId: 'obs-2',
    imageIndex: 1,
    phase: 'failed',
    errorCode: 'VISION_TIMEOUT',
  })).state;

  const cards = projectVisionBridgeCards(state);
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card.anchor.kind, 'user');
  assert.equal(card.items.length, 2);
  assert.equal(card.items[0].imageIndex, 1);
  assert.equal(card.items[0].phase, 'failed');
  assert.equal(card.items[1].imageIndex, 2);
  assert.equal(card.items[1].phase, 'succeeded');
});

test('a tool source anchors by toolCallId', () => {
  let state = createVisionBridgeSessionState();
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    observationId: 'obs-tool',
    phase: 'started',
    source: { kind: 'tool', toolCallId: 'tc-1' },
  })).state;
  state = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    eventId: 'evt-tool-s',
    observationId: 'obs-tool',
    phase: 'succeeded',
    description: 'tool image',
    source: { kind: 'tool', toolCallId: 'tc-1' },
  })).state;
  const [card] = projectVisionBridgeCards(state);
  assert.equal(card.anchor.kind, 'tool');
});

test('a history source anchors by sourceEntryId', () => {
  const state = createVisionBridgeSessionState();
  const seeded = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    observationId: 'hist-tool',
    runId: 'run-x',
    eventId: 'evt-hist-tool',
    phase: 'succeeded',
    description: 'recovered',
    source: { kind: 'history', sourceEntryId: 'entry-9' },
    imageIndex: 1,
  }));
  const [card] = projectVisionBridgeCards(seeded.state);
  assert.equal(card.anchor.kind, 'history');
});

test('a user source without clientMessageId or sourceEntryId is unbound', () => {
  const state = createVisionBridgeSessionState();
  const seeded = applyVisionBridgeEvent(state, 'session-A', buildEvent({
    observationId: 'hist-unbound',
    runId: 'run-x',
    eventId: 'evt-hist-unbound',
    phase: 'succeeded',
    description: 'recovered',
    source: { kind: 'user' },
    imageIndex: 1,
  }));
  const [card] = projectVisionBridgeCards(seeded.state);
  assert.equal(card.anchor.kind, 'unbound');
});
