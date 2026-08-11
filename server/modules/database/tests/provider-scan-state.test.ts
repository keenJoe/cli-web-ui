import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-scan-state-'));
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

const tableExists = (tableName: string): boolean =>
  Boolean(
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );

test('migration creates provider_scan_state keyed by an open-valued provider column', async () => {
  await withIsolatedDatabase(() => {
    assert.ok(tableExists('provider_scan_state'));

    const columns = getConnection()
      .prepare('PRAGMA table_info(provider_scan_state)')
      .all() as { name: string; pk: number }[];

    const providerColumn = columns.find((column) => column.name === 'provider');
    assert.ok(providerColumn, 'provider column must exist');
    assert.equal(providerColumn.pk, 1, 'provider must be the primary key');
    assert.ok(columns.some((column) => column.name === 'last_scanned_at'));

    // Open-valued on purpose: encoding the provider list in the schema would
    // recreate a central change point (design decision 5).
    const createSql = getConnection()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('provider_scan_state') as { sql: string };
    const ddlWithoutComments = createSql.sql.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(ddlWithoutComments, /CHECK/i);
  });
});

test('migration keeps the legacy scan_state table so the cursor change stays rollback-able', async () => {
  await withIsolatedDatabase(() => {
    assert.ok(tableExists('scan_state'));
  });
});

test('migration seeds no rows, so every provider starts from a full scan', async () => {
  await withIsolatedDatabase(() => {
    const rowCount = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM provider_scan_state')
      .get() as { count: number };
    assert.equal(rowCount.count, 0);
  });
});

test('migration is idempotent when run twice', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    scanStateDb.updateLastScannedAt('claude', new Date('2026-01-01T00:00:00.000Z'));

    runMigrations(db, []);

    assert.ok(tableExists('provider_scan_state'));
    assert.deepEqual(
      scanStateDb.getLastScannedAt('claude'),
      new Date('2026-01-01T00:00:00.000Z'),
    );
  });
});

test('scanStateDb reads and writes one cursor per provider', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(scanStateDb.getLastScannedAt('claude'), null);
    assert.equal(scanStateDb.getLastScannedAt('codex'), null);

    scanStateDb.updateLastScannedAt('claude', new Date('2026-02-01T10:00:00.000Z'));

    assert.deepEqual(
      scanStateDb.getLastScannedAt('claude'),
      new Date('2026-02-01T10:00:00.000Z'),
    );
    // Writing one provider's cursor must not create or move any other's.
    assert.equal(scanStateDb.getLastScannedAt('codex'), null);

    scanStateDb.updateLastScannedAt('codex', new Date('2026-03-05T08:30:00.000Z'));
    scanStateDb.updateLastScannedAt('claude', new Date('2026-02-02T11:00:00.000Z'));

    assert.deepEqual(
      scanStateDb.getLastScannedAt('claude'),
      new Date('2026-02-02T11:00:00.000Z'),
    );
    assert.deepEqual(
      scanStateDb.getLastScannedAt('codex'),
      new Date('2026-03-05T08:30:00.000Z'),
    );
  });
});

test('scanStateDb accepts a provider id the schema has never heard of', async () => {
  await withIsolatedDatabase(() => {
    scanStateDb.updateLastScannedAt('brand-new-provider', new Date('2026-04-01T00:00:00.000Z'));

    assert.deepEqual(
      scanStateDb.getLastScannedAt('brand-new-provider'),
      new Date('2026-04-01T00:00:00.000Z'),
    );
  });
});
