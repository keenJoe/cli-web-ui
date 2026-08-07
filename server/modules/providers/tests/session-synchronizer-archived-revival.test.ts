import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runMigrations,
  scanStateDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

const NATIVE_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const CODEX_NATIVE_SESSION_ID = '99999999-8888-7777-6666-555555555555';

// The real registered set, read the same way the assembly root reads it, so
// these tests exercise the production seeding input rather than a hand-listed
// copy that could drift from the registry.
const REGISTERED_PROVIDER_IDS = providerRegistry.listProviders().map((provider) => provider.id);

/**
 * Builds a fixture `~/.claude/projects` tree holding one session transcript,
 * so the real Claude synchronizer has a real artifact to rediscover without
 * ever reading the developer's actual Claude home.
 */
async function writeClaudeFixture(homeDirectory: string, projectPath: string): Promise<void> {
  const transcriptDirectory = path.join(homeDirectory, '.claude', 'projects', 'encoded-project');
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(
    path.join(transcriptDirectory, `${NATIVE_SESSION_ID}.jsonl`),
    `${JSON.stringify({ sessionId: NATIVE_SESSION_ID, cwd: projectPath, type: 'user' })}\n`,
    'utf8',
  );
}

/**
 * Runs the body against a throwaway database and a throwaway Claude home.
 * Both the DB file and the scanned artifact directory live under `mkdtemp`, so
 * the real `~/.cloudcli/auth.db` and the real `~/.claude` are never touched.
 */
async function withUpgradeSimulation(
  runTest: (context: { homeDirectory: string; projectPath: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHomedir = os.homedir;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'archived-revival-'));
  const homeDirectory = path.join(temporaryDirectory, 'home');
  const projectPath = path.join(temporaryDirectory, 'workspace');
  await mkdir(projectPath, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  (os as { homedir: () => string }).homedir = () => homeDirectory;

  try {
    await writeClaudeFixture(homeDirectory, projectPath);
    await initializeDatabase(REGISTERED_PROVIDER_IDS);
    await runTest({ homeDirectory, projectPath });
  } finally {
    closeConnection();
    (os as { homedir: () => string }).homedir = previousHomedir;
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Stands in for the registry with a single provider backed by the *real*
 * Claude synchronizer, constructed after `os.homedir` is redirected so it
 * caches the fixture home rather than the developer's own.
 */
function stubRegistryWithRealClaude(t: { mock: { method: typeof import('node:test').mock.method } }): void {
  const provider = {
    id: 'claude' as LLMProvider,
    sessionSynchronizer: new ClaudeSessionSynchronizer(),
  } as unknown as IProvider;
  t.mock.method(providerRegistry, 'listProviders', () => [provider]);
}

/**
 * Writes a `~/.codex/sessions` rollout for the *same* project path as the
 * Claude fixture. Two providers sharing one `project_path` is what makes the
 * project row revivable by whichever provider rescans first.
 */
async function writeCodexFixture(homeDirectory: string, projectPath: string): Promise<string> {
  const sessionsDirectory = path.join(homeDirectory, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDirectory, { recursive: true });
  const filePath = path.join(sessionsDirectory, `rollout-${CODEX_NATIVE_SESSION_ID}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { id: CODEX_NATIVE_SESSION_ID, cwd: projectPath },
    })}\n`,
    'utf8',
  );
  return filePath;
}

/**
 * Stubs the registry with the real Claude *and* Codex synchronizers, both
 * constructed after `os.homedir` is redirected at the fixture home.
 */
function stubRegistryWithRealClaudeAndCodex(
  t: { mock: { method: typeof import('node:test').mock.method } },
): void {
  const providers = [
    { id: 'claude' as LLMProvider, sessionSynchronizer: new ClaudeSessionSynchronizer() },
    { id: 'codex' as LLMProvider, sessionSynchronizer: new CodexSessionSynchronizer() },
  ] as unknown as IProvider[];
  t.mock.method(providerRegistry, 'listProviders', () => providers);
}

function readSessionIsArchived(sessionId: string): number | undefined {
  const row = getConnection()
    .prepare('SELECT isArchived FROM sessions WHERE session_id = ?')
    .get(sessionId) as { isArchived: number } | undefined;
  return row?.isArchived;
}

function readProviderScanState(): { provider: string; last_scanned_at: string }[] {
  return getConnection()
    .prepare('SELECT provider, last_scanned_at FROM provider_scan_state ORDER BY provider')
    .all() as { provider: string; last_scanned_at: string }[];
}

/**
 * Re-runs the migrations the way the assembly root does, with the full
 * registered provider set injected.
 */
function runUpgradeMigrations(): void {
  runMigrations(getConnection(), REGISTERED_PROVIDER_IDS);
}

// The upgrade that introduced `provider_scan_state` must not turn into a
// one-off full rescan of every historical artifact: soft delete only flips the
// DB flag and leaves the jsonl on disk, and the synchronizer upsert resets
// `isArchived` to 0, so a full rescan silently un-deletes archived rows.
test('an upgrade does not revive archived sessions and projects', async (t) => {
  await withUpgradeSimulation(async ({ homeDirectory, projectPath }) => {
    stubRegistryWithRealClaude(t);

    // Round one stands in for the pre-upgrade install: the artifact is indexed
    // and the legacy global cursor advances past it.
    const firstRound = await sessionSynchronizerService.synchronizeSessions();
    assert.deepEqual(firstRound.failures, []);
    assert.equal(firstRound.processedByProvider.claude, 1);

    const indexedSession = sessionsDb.getSessionByProviderSessionId(NATIVE_SESSION_ID, 'claude');
    assert.ok(indexedSession, 'the fixture session must be indexed before it can be archived');

    // The user soft-deletes the session and archives the project. The jsonl
    // stays on disk, exactly as `sessions.service.ts` leaves it without force.
    sessionsDb.updateSessionIsArchived(indexedSession.session_id, true);
    projectsDb.updateProjectIsArchived(projectPath, true);
    assert.equal(readSessionIsArchived(indexedSession.session_id), 1);
    assert.equal(projectsDb.getProjectPath(projectPath)?.isArchived, 1);

    // Simulate the upgrade: the legacy global cursor holds the value the
    // pre-upgrade rounds reached, and the new per-provider table is empty.
    //
    // The cursor is placed a few seconds past the artifact's birthtime because
    // that is what a live install looks like: rounds keep running after an
    // artifact is indexed. `scan_state` stores whole seconds, so a cursor taken
    // in the same wall-clock second as the fixture write would still sit behind
    // the file's sub-second birthtime and rescan it — a pre-existing quirk of
    // the legacy cursor's granularity, unrelated to archiving.
    const artifactBirthtime = (
      await stat(path.join(homeDirectory, '.claude', 'projects', 'encoded-project', `${NATIVE_SESSION_ID}.jsonl`))
    ).birthtime;
    const legacyCursor = new Date(artifactBirthtime.getTime() + 5_000);
    const database = getConnection();
    database
      .prepare('INSERT OR REPLACE INTO scan_state (id, last_scanned_at) VALUES (1, ?)')
      .run(legacyCursor.toISOString().slice(0, 19).replace('T', ' '));
    database.exec('DELETE FROM provider_scan_state');

    runUpgradeMigrations();

    const afterUpgrade = await sessionSynchronizerService.synchronizeSessions();
    assert.deepEqual(afterUpgrade.failures, []);

    assert.equal(
      readSessionIsArchived(indexedSession.session_id),
      1,
      'the archived session must stay archived across the upgrade',
    );
    assert.equal(
      projectsDb.getProjectPath(projectPath)?.isArchived,
      1,
      'the archived project must stay archived across the upgrade',
    );
  });
});

// Seeding runs on every startup, so it must be idempotent and must never
// rewind a cursor the synchronizers already advanced past the legacy value.
test('seeding is idempotent and never rewinds an already advanced cursor', async (t) => {
  await withUpgradeSimulation(async () => {
    stubRegistryWithRealClaude(t);

    const database = getConnection();

    // A pre-upgrade install: sessions exist for claude, and the legacy global
    // cursor holds the round boundary they were indexed under.
    await sessionSynchronizerService.synchronizeSessions();
    const legacyValue = '2026-01-01 00:00:00';
    database
      .prepare('INSERT OR REPLACE INTO scan_state (id, last_scanned_at) VALUES (1, ?)')
      .run(legacyValue);
    database.exec('DELETE FROM provider_scan_state');

    runUpgradeMigrations();
    const afterFirstRun = readProviderScanState();
    assert.deepEqual(
      afterFirstRun,
      [...REGISTERED_PROVIDER_IDS]
        .sort()
        .map((provider) => ({ provider, last_scanned_at: legacyValue })),
      'the legacy cursor is seeded for every registered provider',
    );

    runUpgradeMigrations();
    assert.deepEqual(afterFirstRun, readProviderScanState(), 'a second migration run changes nothing');

    // The synchronizer now advances claude's own cursor well past the legacy
    // value. A later migration run must leave that progress alone.
    const advancedValue = '2026-06-01 12:00:00';
    database
      .prepare('UPDATE provider_scan_state SET last_scanned_at = ? WHERE provider = ?')
      .run(advancedValue, 'claude');

    runUpgradeMigrations();
    assert.equal(
      readProviderScanState().find((row) => row.provider === 'claude')?.last_scanned_at,
      advancedValue,
      'seeding must not rewind a cursor the synchronizer already advanced',
    );
  });
});

// A brand-new install has no legacy cursor and nothing archived, so it should
// keep the full-scan behavior instead of inheriting a fabricated cursor.
test('a fresh install with no legacy cursor is not seeded', async (t) => {
  await withUpgradeSimulation(async () => {
    stubRegistryWithRealClaude(t);

    const database = getConnection();

    database.exec('DELETE FROM scan_state');
    database.exec('DELETE FROM provider_scan_state');

    runUpgradeMigrations();

    assert.deepEqual(readProviderScanState(), [], 'no legacy cursor means no seeded rows');
  });
});

// The `projects` table is independent of `sessions`: an archived project can be
// revived by *any* provider writing a row for the same `project_path`. So a
// registered provider with zero `sessions` rows but artifacts still on disk
// (force-delete with `deletedFromDisk=false`, or a provider used before the
// install started indexing it) must also be seeded, or its full rescan
// un-archives a project another provider archived.
test('an upgrade does not revive a project through a provider that has no session rows', async (t) => {
  await withUpgradeSimulation(async ({ homeDirectory, projectPath }) => {
    stubRegistryWithRealClaudeAndCodex(t);
    const codexArtifactPath = await writeCodexFixture(homeDirectory, projectPath);

    // Pre-upgrade: both providers indexed their artifact into the same project.
    const firstRound = await sessionSynchronizerService.synchronizeSessions();
    assert.deepEqual(firstRound.failures, []);
    assert.equal(firstRound.processedByProvider.claude, 1);
    assert.equal(firstRound.processedByProvider.codex, 1);

    // Codex's session row is gone while its artifact stays on disk, so codex is
    // a registered provider with zero rows in `sessions`.
    getConnection().prepare('DELETE FROM sessions WHERE provider = ?').run('codex');
    assert.equal(
      sessionsDb.getSessionByProviderSessionId(CODEX_NATIVE_SESSION_ID, 'codex'),
      null,
    );

    projectsDb.updateProjectIsArchived(projectPath, true);
    assert.equal(projectsDb.getProjectPath(projectPath)?.isArchived, 1);

    const artifactBirthtime = (await stat(codexArtifactPath)).birthtime;
    const legacyCursor = new Date(artifactBirthtime.getTime() + 5_000);
    const database = getConnection();
    database
      .prepare('INSERT OR REPLACE INTO scan_state (id, last_scanned_at) VALUES (1, ?)')
      .run(legacyCursor.toISOString().slice(0, 19).replace('T', ' '));
    database.exec('DELETE FROM provider_scan_state');

    runUpgradeMigrations();

    assert.ok(
      readProviderScanState().some((row) => row.provider === 'codex'),
      'a registered provider with zero session rows must still be seeded',
    );

    const afterUpgrade = await sessionSynchronizerService.synchronizeSessions();
    assert.deepEqual(afterUpgrade.failures, []);

    assert.equal(
      projectsDb.getProjectPath(projectPath)?.isArchived,
      1,
      'the archived project must survive the upgrade round',
    );
  });
});

// A provider registered by a *later* release must not inherit a cursor that
// covers artifacts it never scanned, which is spec scenario 3 (never-scanned
// provider runs a full scan). Seeding only fires while the table is empty, so
// the upgrade round cannot hand a cursor to a provider added afterwards.
test('a provider registered after the upgrade round is not seeded and still scans fully', async (t) => {
  await withUpgradeSimulation(async () => {
    stubRegistryWithRealClaude(t);

    const database = getConnection();
    database
      .prepare('INSERT OR REPLACE INTO scan_state (id, last_scanned_at) VALUES (1, ?)')
      .run('2026-01-01 00:00:00');
    database.exec('DELETE FROM provider_scan_state');

    runMigrations(database, ['claude']);
    assert.deepEqual(
      readProviderScanState().map((row) => row.provider),
      ['claude'],
      'the upgrade round seeds the providers registered at that time',
    );

    // A later release adds a provider. Its cursor row must stay absent.
    runMigrations(database, ['claude', 'brand-new-provider']);

    assert.deepEqual(
      readProviderScanState().map((row) => row.provider),
      ['claude'],
      'a later-registered provider gets no cursor and therefore runs a full scan',
    );
    assert.equal(scanStateDb.getLastScannedAt('brand-new-provider'), null);
  });
});
