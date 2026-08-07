import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

const ROLLBACK_SCRIPT_PATH = fileURLToPath(
  new URL('../../../../scripts/rollback/drop-provider-native-id-index.sql', import.meta.url),
);

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-native-id-'));
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

const indexDefinition = (): string | undefined => {
  const row = getConnection()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get('idx_sessions_provider_native_id') as { sql: string } | undefined;
  return row?.sql;
};

const insertRawSession = (
  sessionId: string,
  provider: string,
  providerSessionId: string | null,
  updatedAt: string,
): void => {
  getConnection()
    .prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, provider, providerSessionId, updatedAt, updatedAt);
};

// R14: the migration must add a provider-qualified partial unique index.
test('migration creates the partial unique index on (provider, provider_session_id)', async () => {
  await withIsolatedDatabase(() => {
    const sql = indexDefinition();

    assert.ok(sql, 'idx_sessions_provider_native_id must exist after migrations');
    assert.match(sql, /CREATE\s+UNIQUE\s+INDEX/i);
    assert.match(sql, /\(\s*provider\s*,\s*provider_session_id\s*\)/i);
    assert.match(sql, /WHERE\s+provider_session_id\s+IS\s+NOT\s+NULL/i);
  });
});

// R14: same provider + same native id is rejected.
test('index rejects a duplicate native id inside the same provider', async () => {
  await withIsolatedDatabase(() => {
    insertRawSession('row-a', 'claude', 'native-1', '2026-01-01 00:00:00');

    assert.throws(
      () => insertRawSession('row-b', 'claude', 'native-1', '2026-01-02 00:00:00'),
      /UNIQUE constraint failed/,
    );
  });
});

// R14: the constraint must not misfire across providers or on NULL native ids.
test('index keeps the same native id across providers and allows many NULL native ids', async () => {
  await withIsolatedDatabase(() => {
    insertRawSession('row-claude', 'claude', 'shared-native', '2026-01-01 00:00:00');
    insertRawSession('row-codex', 'codex', 'shared-native', '2026-01-01 00:00:00');
    insertRawSession('row-null-1', 'claude', null, '2026-01-01 00:00:00');
    insertRawSession('row-null-2', 'claude', null, '2026-01-01 00:00:00');

    const rows = getConnection()
      .prepare('SELECT session_id FROM sessions ORDER BY session_id')
      .all() as { session_id: string }[];

    assert.deepEqual(
      rows.map((row) => row.session_id),
      ['row-claude', 'row-codex', 'row-null-1', 'row-null-2'],
    );
  });
});

// R14: a database that already holds duplicates must be reconciled
// deterministically, provider-qualified, without deleting any row.
test('migration demotes older duplicates and never merges across providers', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.exec('DROP INDEX IF EXISTS idx_sessions_provider_native_id');

    insertRawSession('dup-old', 'claude', 'native-dup', '2026-01-01 00:00:00');
    insertRawSession('dup-new', 'claude', 'native-dup', '2026-03-01 00:00:00');
    insertRawSession('other-provider', 'codex', 'native-dup', '2026-02-01 00:00:00');

    runMigrations(db, []);

    assert.ok(indexDefinition(), 'index must exist after re-running migrations');

    const rows = db
      .prepare('SELECT session_id, provider_session_id FROM sessions ORDER BY session_id')
      .all() as { session_id: string; provider_session_id: string | null }[];

    // Every row survives: only the losing duplicate's mapping is cleared, and
    // the codex row keeps the same native id because the index is qualified by
    // provider.
    assert.deepEqual(rows, [
      { session_id: 'dup-new', provider_session_id: 'native-dup' },
      { session_id: 'dup-old', provider_session_id: null },
      { session_id: 'other-provider', provider_session_id: 'native-dup' },
    ]);
  });
});

test('migration is idempotent when run twice', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const firstDefinition = indexDefinition();

    runMigrations(db, []);

    assert.equal(indexDefinition(), firstDefinition);

    const indexCount = db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_sessions_provider_native_id') as { count: number };
    assert.equal(indexCount.count, 1);
  });
});

// R19: the manual rollback script is the only down path (no migration framework).
test('rollback script drops the index and leaves the legacy write path working', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    assert.ok(indexDefinition(), 'index must exist before the rollback drill');

    const rollbackSql = await readFile(ROLLBACK_SCRIPT_PATH, 'utf8');
    db.exec(rollbackSql);

    assert.equal(indexDefinition(), undefined);

    // Legacy code path: duplicates are tolerated again, and the repository
    // reads/writes still work exactly as before the migration.
    insertRawSession('legacy-a', 'claude', 'native-legacy', '2026-01-01 00:00:00');
    insertRawSession('legacy-b', 'claude', 'native-legacy', '2026-01-02 00:00:00');

    sessionsDb.createAppSession('legacy-app', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('legacy-app', 'native-app', 'codex');

    assert.equal(sessionsDb.getSessionById('legacy-app')?.provider_session_id, 'native-app');
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('native-app', 'codex')?.session_id,
      'legacy-app',
    );
  });
});
