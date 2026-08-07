import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-details-'));
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

test('getSessionDetailsById resolves the owning project for a disk-indexed session', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/home/user/example-project';
    const sessionId = sessionsDb.createSession('provider-abc', 'claude', projectPath, 'My session');
    const projectRow = projectsDb.getProjectPath(projectPath);
    assert.ok(projectRow, 'project row should exist after createSession');

    const details = sessionsService.getSessionDetailsById(sessionId, 'claude');

    assert.equal(details.sessionId, sessionId);
    assert.equal(details.provider, 'claude');
    assert.equal(details.summary, 'My session');
    assert.equal(details.isArchived, false);
    assert.ok(details.project, 'project should be resolved');
    assert.equal(details.project?.projectId, projectRow?.project_id);
    // Paths are normalized to platform separators when stored.
    assert.equal(details.project?.fullPath, normalizeProjectPath(projectPath));
  });
});

test('getSessionDetailsById falls back to the provider-native id and returns the canonical app id', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/home/user/alias-project';
    const appSessionId = sessionsDb.createAppSession('app-session-1', 'claude', projectPath);
    sessionsDb.assignProviderSessionId(appSessionId, 'provider-native-1', 'claude');

    const details = sessionsService.getSessionDetailsById('provider-native-1', 'claude');

    assert.equal(details.sessionId, appSessionId);
    assert.equal(details.project?.fullPath, normalizeProjectPath(projectPath));
  });
});

test('getSessionDetailsById resolves a shared provider-native id within the requested provider', async () => {
  await withIsolatedDatabase(() => {
    const nativeSessionId = 'shared-native-session';
    const claudeSessionId = sessionsDb.createAppSession(
      'app-session-claude',
      'claude',
      '/home/user/claude-project',
    );
    sessionsDb.assignProviderSessionId(claudeSessionId, nativeSessionId, 'claude');

    const codexSessionId = sessionsDb.createAppSession(
      'app-session-codex',
      'codex',
      '/home/user/codex-project',
    );
    sessionsDb.assignProviderSessionId(codexSessionId, nativeSessionId, 'codex');

    getConnection().prepare(
      `UPDATE sessions
       SET updated_at = ?
       WHERE session_id = ?`,
    ).run('2099-01-01T00:00:00.000Z', codexSessionId);

    const details = sessionsService.getSessionDetailsById(nativeSessionId, 'claude');

    assert.equal(details.sessionId, claudeSessionId);
    assert.equal(details.provider, 'claude');
  });
});

test('getSessionDetailsById keeps canonical app ids independent from the native-id provider hint', async () => {
  await withIsolatedDatabase(() => {
    const appSessionId = sessionsDb.createAppSession(
      'canonical-app-session',
      'claude',
      '/home/user/canonical-project',
    );

    const details = sessionsService.getSessionDetailsById(appSessionId, 'codex');

    assert.equal(details.sessionId, appSessionId);
    assert.equal(details.provider, 'claude');
  });
});

test('getSessionDetailsById throws SESSION_NOT_FOUND for unknown ids', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getSessionDetailsById('does-not-exist', 'claude'),
      (error: unknown) => error instanceof AppError && error.code === 'SESSION_NOT_FOUND',
    );
  });
});
