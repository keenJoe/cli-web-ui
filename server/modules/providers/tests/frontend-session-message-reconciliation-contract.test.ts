import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('frontend session message reconciliation contract suite passes', () => {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    TSX_TSCONFIG_PATH: 'tsconfig.json',
  };
  delete childEnvironment.NODE_TEST_CONTEXT;

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      'src/stores/sessionMessageReconciliation.test.ts',
    ],
    {
      cwd: process.cwd(),
      env: childEnvironment,
      encoding: 'utf8',
    },
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
  const requiredTestNames = [
    'shows one Pi user, thinking, and assistant row after persisted history catches up',
    'preserves an ambiguous realtime turn when message timestamps are invalid',
    'preserves a new realtime turn when server clock skew makes an old turn arrive later',
    'keeps a current answer when its persisted user arrives 300ms later',
    'keeps an unpersisted current answer across sequential refreshes',
    'clears a retained current answer when a later snapshot persists it',
    'propagates retained turn lineage to a newly appended realtime child',
    'keeps current thinking when identical text belongs to an older server turn',
    'keeps unpersisted current thinking across sequential refreshes',
    'matches identical finalized thinking rows to one server row at most once',
    'keeps streaming thinking and assistant snapshots visible',
    'does not let a completed tool-only turn consume a later same-text optimistic user',
    'does not let a completed error-only turn consume a later same-text optimistic user',
    'does not let a turn-end status consume a later same-text optimistic user',
    'preserves a later same-text optimistic user when an older server user is ambiguous',
    'preserves one optimistic user when two persisted user candidates are eligible',
    'renders a current answer when timestamp sorting places it beside an older identical answer',
    'retains active turn lineage after every anchored realtime row reconciles',
    'does not match a local user to a server turn with earlier thinking activity',
    'does not match a local user to a server turn with earlier status activity',
    'renders invalid-timestamp realtime rows after valid persisted history',
    'store preserves turn lineage through updateStreaming and finalizeStreaming',
    'drops an exact websocket replay after its finalized answer already reconciled',
    'store prunes discarded realtime lineage for append and batch caps',
    'bounds replay tombstones and releases them at a clean local turn boundary',
    'reconciles completed raw stream deltas whether terminal or missing streaming flag',
    'reconciles a terminal raw stream delta without a realtime user anchor',
    'keeps an unanchored raw stream when multiple persisted turns could echo it',
    'keeps an unanchored raw stream before a future persisted turn',
    'does not let a late older replay inherit a newer realtime user turn',
    'rebases stale lineage before an unanchored stream in a later persisted turn',
    'store keeps an old hidden replay from anchoring the next turn',
    'store keeps a late old replay after the newer user has reconciled',
    'store clears stale lineage when a newer persisted user has an invalid timestamp',
    'store does not infer a raw stream echo across an invalid user timestamp',
    'store keeps a late finalized assistant replay before the active user anchor',
    'store keeps late thinking and streaming replays before the active user anchor',
    'store retains sequential assistant lineage across persisted user clock skew',
    'store keeps the active turn when persisted user timestamps move backwards across turns',
    'store keeps the active turn when clock-rollback history preserves structural order',
    'store keeps clock-rollback lineage for thinking and streaming terminal rows',
    'store keeps clock-rollback lineage for structural-order thinking and streaming rows',
    'cleans hidden replay lineage before the next local turn',
    'store writes hidden replay reconciliation back to raw realtime state',
    'bounds claimed server message ids for a large persisted transcript',
  ];
  for (const testName of requiredTestNames) {
    assert.ok(
      result.stdout.includes(testName),
      `Frontend reconciliation output did not include required test: ${testName}`,
    );
  }
  assert.match(result.stdout, /fail 0/);
});
