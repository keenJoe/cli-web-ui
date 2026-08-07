import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-identity-'));
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

// R5: two providers holding the same native id are two distinct sessions.
// Both rows must survive; neither may be deleted by the merge path.
test('assignProviderSessionId keeps another provider row that already maps the same native id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-claude', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-claude', 'shared-native', 'claude');

    sessionsDb.createAppSession('app-codex', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-codex', 'shared-native', 'codex');

    const rows = sessionsDb.getAllSessions();
    assert.deepEqual(
      rows.map((row) => row.session_id).sort(),
      ['app-claude', 'app-codex'],
      'both provider rows must survive the cross-provider native id collision',
    );
    assert.equal(sessionsDb.getSessionById('app-claude')?.provider_session_id, 'shared-native');
    assert.equal(sessionsDb.getSessionById('app-codex')?.provider_session_id, 'shared-native');
  });
});

// R5: the disk-discovered shape of the same collision. Rows indexed from disk
// key both columns with the native id, so the merge lookup's `session_id = ?`
// branch must also be provider-qualified.
test('assignProviderSessionId keeps another provider disk-discovered row keyed by the same native id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('shared-native', 'claude', '/workspace/demo', 'From Claude Disk');

    sessionsDb.createAppSession('app-codex', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-codex', 'shared-native', 'codex');

    const claudeRow = sessionsDb.getSessionById('shared-native');
    assert.ok(claudeRow, 'the claude row must not be deleted');
    assert.equal(claudeRow?.provider, 'claude');
    assert.equal(claudeRow?.custom_name, 'From Claude Disk');
    assert.equal(sessionsDb.getSessionById('app-codex')?.provider_session_id, 'shared-native');
    assert.equal(sessionsDb.getAllSessions().length, 2);
  });
});

// R5: reads are provider-qualified too, so each provider resolves its own row.
test('getSessionByProviderSessionId resolves the row of the requested provider', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-claude', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-claude', 'shared-native', 'claude');
    sessionsDb.createAppSession('app-codex', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-codex', 'shared-native', 'codex');

    assert.equal(
      sessionsDb.getSessionByProviderSessionId('shared-native', 'claude')?.session_id,
      'app-claude',
    );
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('shared-native', 'codex')?.session_id,
      'app-codex',
    );
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('shared-native', 'opencode'),
      null,
      'a provider without that native id must not borrow another provider row',
    );
  });
});

// R6: inside one provider a repeated native id is merged deterministically into
// the session that claims it last, without violating the unique index.
test('assignProviderSessionId merges a repeated native id within the same provider', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-first', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-first', 'native-dup', 'claude');

    sessionsDb.createAppSession('app-second', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-second', 'native-dup', 'claude');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1, 'the duplicate is merged, not left as a second row');
    assert.equal(rows[0]?.session_id, 'app-second');
    assert.equal(rows[0]?.provider_session_id, 'native-dup');
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('native-dup', 'claude')?.session_id,
      'app-second',
    );
  });
});

test('assignProviderSessionId prioritizes the existing native mapping over an app-id collision', async () => {
  await withIsolatedDatabase(() => {
    const nativeSessionId = 'native-alias-collision';
    sessionsDb.createAppSession('target-app-session', 'claude', '/workspace/demo');

    const db = getConnection();
    db.prepare(
      `INSERT INTO sessions (
         session_id,
         provider,
         provider_session_id,
         custom_name,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(nativeSessionId, 'claude', 'unrelated-native-id', 'Keep this app-id row');
    db.prepare(
      `INSERT INTO sessions (
         session_id,
         provider,
         provider_session_id,
         custom_name,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run('existing-native-owner', 'claude', nativeSessionId, 'Merge this native row');

    sessionsDb.assignProviderSessionId('target-app-session', nativeSessionId, 'claude');

    assert.equal(
      sessionsDb.getSessionById('target-app-session')?.provider_session_id,
      nativeSessionId,
    );
    assert.equal(
      sessionsDb.getSessionById('target-app-session')?.custom_name,
      'Merge this native row',
    );
    assert.equal(
      sessionsDb.getSessionById(nativeSessionId)?.provider_session_id,
      'unrelated-native-id',
      'a coincidental app-session id must not be selected as the merge source',
    );
    assert.equal(sessionsDb.getSessionById('existing-native-owner'), null);
  });
});

// R7: an app id that happens to equal the native id still gets an explicit
// mapping instead of being skipped as a self-duplicate.
test('assignProviderSessionId records the mapping when app id equals native id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('same-id', 'pi', '/workspace/demo');
    sessionsDb.assignProviderSessionId('same-id', 'same-id', 'pi');

    const row = sessionsDb.getSessionById('same-id');
    assert.equal(row?.provider_session_id, 'same-id');
    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('same-id', 'pi')?.session_id,
      'same-id',
    );
  });
});
