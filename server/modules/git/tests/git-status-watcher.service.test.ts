import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';

import {
  closeGitStatusWatcher,
  initializeGitStatusWatcher,
} from '../git-status-watcher.service.js';
import {
  configureGitStatusPublisher,
  createInMemoryGitStatusPublisher,
} from '../git-status-publisher.service.js';
import type { GitStatusEvent } from '@/shared/types.js';

const GIT_BIN = 'git';

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  const { default: spawn } = await import('cross-spawn');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exit ${code}: ${stderr}`))));
  });
}

async function makeTempRepo(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'git-watcher-'));
  await run(GIT_BIN, ['init', '-q', '--initial-branch=main'], dir);
  await run(GIT_BIN, ['config', 'user.email', 'test@test.test'], dir);
  await run(GIT_BIN, ['config', 'user.name', 'Test'], dir);
  await fsPromises.writeFile(path.join(dir, 'README.md'), 'init\n');
  await run(GIT_BIN, ['add', '.'], dir);
  await run(GIT_BIN, ['commit', '-q', '-m', 'init'], dir);
  return dir;
}

/** Polls the captured events until predicate passes or times out. */
async function waitFor<T>(
  fn: () => T | undefined,
  { timeoutMs = 4_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = fn();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function withProjectRow(projectId: string, projectPath: string): ProjectRepositoryRow {
  return {
    project_id: projectId,
    project_path: projectPath,
    custom_project_name: null,
    isStarred: 0,
    isArchived: 0,
  } as ProjectRepositoryRow;
}

test('S07 real checkout changes .git/HEAD and broadcasts the new branch', async () => {
  const repo = await makeTempRepo();
  const inMemory = createInMemoryGitStatusPublisher();
  const restorePublisher = configureGitStatusPublisher(inMemory);
  const mock = test.mock.method(projectsDb, 'getProjectPaths', () => [withProjectRow('p-s07', repo)]);

  try {
    initializeGitStatusWatcher();
    // Give chokidar a moment to settle its initial watch before we mutate.
    await new Promise((r) => setTimeout(r, 300));
    await run(GIT_BIN, ['checkout', '-q', '-b', 'feature'], repo);

    const event = await waitFor<GitStatusEvent>(() =>
      inMemory.events.find((e) => e.projectId === 'p-s07' && e.branch === 'feature'),
    );
    assert.equal(event.isGitRepository, true);
    assert.equal(event.isDetached, false);
  } finally {
    await closeGitStatusWatcher();
    mock.mock.restore();
    restorePublisher();
    await fsPromises.rm(repo, { recursive: true, force: true });
  }
});

test('S17/S18 multiple rapid .git/HEAD writes within the debounce window collapse to one broadcast', async () => {
  const repo = await makeTempRepo();
  const inMemory = createInMemoryGitStatusPublisher();
  const restorePublisher = configureGitStatusPublisher(inMemory);
  const mock = test.mock.method(projectsDb, 'getProjectPaths', () => [withProjectRow('p-s17', repo)]);

  try {
    initializeGitStatusWatcher();
    await new Promise((r) => setTimeout(r, 300));

    const before = inMemory.events.length;
    // Rapidly overwrite .git/HEAD content several times in a tight loop, all
    // within one 500ms debounce window. Only the last value should win, and
    // only one broadcast should fire after the window settles.
    const headPath = path.join(repo, '.git', 'HEAD');
    for (let i = 0; i < 5; i += 1) {
      await fsPromises.writeFile(headPath, `ref: refs/heads/main\n`);
    }

    await waitFor(() => {
      const after = inMemory.events.length;
      return after > before ? after : undefined;
    });

    // Allow a full debounce window to elapse and assert no extra broadcast.
    await new Promise((r) => setTimeout(r, 900));
    const added = inMemory.events.length - before;
    assert.equal(added, 1, `expected 1 broadcast after debounce, got ${added}`);
  } finally {
    await closeGitStatusWatcher();
    mock.mock.restore();
    restorePublisher();
    await fsPromises.rm(repo, { recursive: true, force: true });
  }
});

test('S15 deleting .git broadcasts a hide event (isGitRepository:false)', async () => {
  const repo = await makeTempRepo();
  const inMemory = createInMemoryGitStatusPublisher();
  const restorePublisher = configureGitStatusPublisher(inMemory);
  const mock = test.mock.method(projectsDb, 'getProjectPaths', () => [withProjectRow('p-s15', repo)]);

  try {
    initializeGitStatusWatcher();
    await new Promise((r) => setTimeout(r, 300));

    await fsPromises.rm(path.join(repo, '.git'), { recursive: true, force: true });

    await waitFor<GitStatusEvent>(() =>
      inMemory.events.find((e) => e.projectId === 'p-s15' && e.isGitRepository === false),
    );
  } finally {
    await closeGitStatusWatcher();
    mock.mock.restore();
    restorePublisher();
    await fsPromises.rm(repo, { recursive: true, force: true });
  }
});

test('S13 git subprocess failure does not crash the watcher; a hide event is published', async () => {
  // A directory that is not a git repo: every git invocation fails, so the
  // snapshot resolves to isGitRepository:false. We trigger a broadcast by
  // touching a fake .git/HEAD so chokidar fires a change on a watched path.
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'git-watcher-nongit-'));
  await fsPromises.mkdir(path.join(dir, '.git'));
  await fsPromises.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const inMemory = createInMemoryGitStatusPublisher();
  const restorePublisher = configureGitStatusPublisher(inMemory);
  const mock = test.mock.method(projectsDb, 'getProjectPaths', () => [withProjectRow('p-s13', dir)]);

  try {
    initializeGitStatusWatcher();
    await new Promise((r) => setTimeout(r, 300));

    // Mutate the watched HEAD path to trigger a broadcast attempt. Since the
    // directory is not a real repo, resolveGitStatusSnapshot returns
    // isGitRepository:false rather than throwing, so the watcher survives.
    await fsPromises.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');

    await waitFor<GitStatusEvent>(() =>
      inMemory.events.find((e) => e.projectId === 'p-s13' && e.isGitRepository === false),
    );
  } finally {
    await closeGitStatusWatcher();
    mock.mock.restore();
    restorePublisher();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
