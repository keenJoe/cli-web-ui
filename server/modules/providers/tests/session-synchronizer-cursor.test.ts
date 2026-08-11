import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scanStateDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

type SynchronizeCall = { provider: string; since: Date | undefined };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-sync-cursor-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase([]);

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * A provider stub whose only real behavior is recording the `since` cursor it
 * was handed and either counting a scan or failing it.
 */
function createSynchronizerProvider(
  id: string,
  calls: SynchronizeCall[],
  behavior: { failWith?: string; processed?: number } = {},
): IProvider {
  return {
    id: id as LLMProvider,
    sessionSynchronizer: {
      async synchronize(since?: Date) {
        calls.push({ provider: id, since });
        if (behavior.failWith) {
          throw new Error(behavior.failWith);
        }
        return behavior.processed ?? 1;
      },
      async synchronizeFile() {
        return null;
      },
    },
  } as unknown as IProvider;
}

function stubRegistry(t: { mock: { method: typeof import('node:test').mock.method } }, providers: IProvider[]): void {
  t.mock.method(providerRegistry, 'listProviders', () => providers);
}

// R8: one provider failing must not hold back anybody else's cursor.
test('a failing provider does not block the other providers from advancing their cursors', async (t) => {
  await withIsolatedDatabase(async () => {
    const calls: SynchronizeCall[] = [];
    stubRegistry(t, [
      createSynchronizerProvider('claude', calls, { processed: 3 }),
      createSynchronizerProvider('codex', calls, { failWith: 'codex scan exploded' }),
      createSynchronizerProvider('cursor', calls, { processed: 2 }),
    ]);

    // Freeze the clock so the round's scan boundary is a known instant and the
    // cursor can be asserted exactly, rather than merely as "not null" — that
    // way a cursor written at the wrong point in time cannot slip through.
    // Whole seconds only, because that is the granularity the column stores.
    const expectedCursor = new Date('2026-03-04T05:06:07.000Z');
    t.mock.timers.enable({ apis: ['Date'], now: expectedCursor });

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(result.failures, [{ provider: 'codex', reason: 'codex scan exploded' }]);
    assert.equal(result.processedByProvider.claude, 3);
    assert.equal(result.processedByProvider.cursor, 2);

    assert.deepEqual(
      scanStateDb.getLastScannedAt('claude'),
      expectedCursor,
      'claude succeeded, so its cursor must advance to the round boundary',
    );
    assert.deepEqual(
      scanStateDb.getLastScannedAt('cursor'),
      expectedCursor,
      'cursor succeeded, so its cursor must advance to the round boundary',
    );
    assert.equal(
      scanStateDb.getLastScannedAt('codex'),
      null,
      'codex failed, so only its own cursor stays put',
    );
  });
});

// R9: the failed provider resumes from its own cursor, not from anybody else's.
test('the failed provider rescans from its own cursor next round while others go incremental', async (t) => {
  await withIsolatedDatabase(async () => {
    const calls: SynchronizeCall[] = [];
    let codexFails = true;
    const codexProvider = {
      id: 'codex' as LLMProvider,
      sessionSynchronizer: {
        async synchronize(since?: Date) {
          calls.push({ provider: 'codex', since });
          if (codexFails) {
            throw new Error('codex scan exploded');
          }
          return 5;
        },
        async synchronizeFile() {
          return null;
        },
      },
    } as unknown as IProvider;

    stubRegistry(t, [createSynchronizerProvider('claude', calls), codexProvider]);

    await sessionSynchronizerService.synchronizeSessions();

    const claudeCursorAfterFirstRound = scanStateDb.getLastScannedAt('claude');
    assert.ok(claudeCursorAfterFirstRound);

    codexFails = false;
    const secondRound = await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(secondRound.failures, []);

    const secondRoundCalls = calls.slice(2);
    const claudeSecondCall = secondRoundCalls.find((call) => call.provider === 'claude');
    const codexSecondCall = secondRoundCalls.find((call) => call.provider === 'codex');

    assert.deepEqual(
      claudeSecondCall?.since,
      claudeCursorAfterFirstRound,
      'claude continues incrementally from its own cursor',
    );
    assert.equal(
      codexSecondCall?.since,
      undefined,
      'codex never recorded a cursor, so it retries the full scan instead of borrowing one',
    );

    assert.ok(scanStateDb.getLastScannedAt('codex'), 'codex recovered, so its cursor advances now');
  });
});

// R9 / spec scenario 3: a provider with no cursor row runs a full scan and
// leaves everyone else's incremental cursor alone.
test('a never-scanned provider goes full scan without disturbing the other cursors', async (t) => {
  await withIsolatedDatabase(async () => {
    const firstRoundCalls: SynchronizeCall[] = [];
    stubRegistry(t, [createSynchronizerProvider('claude', firstRoundCalls)]);

    await sessionSynchronizerService.synchronizeSessions();
    const claudeCursor = scanStateDb.getLastScannedAt('claude');
    assert.ok(claudeCursor);

    t.mock.restoreAll();

    const secondRoundCalls: SynchronizeCall[] = [];
    stubRegistry(t, [
      createSynchronizerProvider('claude', secondRoundCalls),
      createSynchronizerProvider('newcomer', secondRoundCalls),
    ]);

    await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(
      secondRoundCalls.find((call) => call.provider === 'claude')?.since,
      claudeCursor,
      'the existing provider keeps its incremental cursor',
    );
    assert.equal(
      secondRoundCalls.find((call) => call.provider === 'newcomer')?.since,
      undefined,
      'a provider with no cursor row scans everything',
    );
  });
});

// The processed tally must come from the registry, so registering a provider
// never requires editing session-synchronizer.service.ts.
test('processedByProvider keys come from the registry, not from a hardcoded list', async (t) => {
  await withIsolatedDatabase(async () => {
    const calls: SynchronizeCall[] = [];
    stubRegistry(t, [
      createSynchronizerProvider('claude', calls, { processed: 4 }),
      createSynchronizerProvider('newcomer', calls, { processed: 7 }),
    ]);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(Object.keys(result.processedByProvider).sort(), ['claude', 'newcomer']);
    assert.equal(result.processedByProvider.claude, 4);
    assert.equal(
      (result.processedByProvider as Record<string, number>).newcomer,
      7,
    );
  });
});
