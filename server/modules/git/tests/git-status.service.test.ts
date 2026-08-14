import assert from 'node:assert/strict';
import test from 'node:test';

import type { GitStatusEvent } from '@/shared/types.js';

import {
  buildGitStatusEvent,
  resolveGitStatusSnapshot,
  type GitSpawn,
} from '../git-status.service.js';

/**
 * Fake `git` subprocess launcher for the status service. Each entry maps an
 * args array (joined) to either a trimmed stdout or an Error that mimics a
 * failed `git` invocation. This drives detached/clean/non-repo/timeout cases
 * without spawning real git, while the watcher integration test exercises the
 * real binary on a temp repo.
 */
function fakeSpawn(table: Record<string, string | Error>): GitSpawn {
  return ((_command: string, args: string[], _options: unknown) => {
    const key = args.join(' ');
    const match = table[key];
    // Real git exits non-zero (close code 1/128) on failure; only spawn-level
    // problems fire Node's 'error'. We model every table entry that is an Error
    // as a non-zero exit so the service rejects via the close handler.
    const exitCode = match instanceof Error ? 1 : 0;
    const stdoutPayload = typeof match === 'string' ? match : '';
    const child = {
      stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { if (stdoutPayload) cb(Buffer.from(stdoutPayload)); } },
      stderr: {
        on: (_e: string, cb: (data: Buffer) => void) => {
          if (match instanceof Error) cb(Buffer.from(match.message));
        },
      },
      on: (event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'close') setImmediate(() => cb(exitCode));
      },
      kill: () => {},
    };
    return child as unknown as ReturnType<GitSpawn>;
  }) as GitSpawn;
}

test('S01 normal repo reports branch and modified+untracked count, excluding the staged bucket', async () => {
  const spawn = fakeSpawn({
    'symbolic-ref --short HEAD': 'develop\n',
    'status --porcelain=v1 -z': ['M  staged-only.ts', ' M unstaged.ts', '?? untracked.ts'].join('\0') + '\0',
  });
  const snapshot = await resolveGitStatusSnapshot('/repo', { spawn });
  assert.equal(snapshot.branch, 'develop');
  assert.equal(snapshot.isDetached, false);
  assert.equal(snapshot.isGitRepository, true);
  // modified=2 (staged-only index-modified + unstaged modified) + untracked=1
  // = 3. The staged bucket (length 1) is NOT added on top, matching the spec's
  // "exclude staged" requirement: staged-only files appear once via modified.
  assert.equal(snapshot.uncommittedCount, 3);
});

test('S02 clean working tree yields count 0', async () => {
  const spawn = fakeSpawn({
    'symbolic-ref --short HEAD': 'main\n',
    'status --porcelain=v1 -z': '\0',
  });
  const snapshot = await resolveGitStatusSnapshot('/repo', { spawn });
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.uncommittedCount, 0);
  assert.equal(snapshot.isGitRepository, true);
});

test('S03 detached HEAD falls back to 7-char short hash and isDetached true', async () => {
  const spawn = fakeSpawn({
    'symbolic-ref --short HEAD': new Error('not a symbolic ref'),
    'rev-parse --short HEAD': 'a1b2c3d\n',
    'status --porcelain=v1 -z': '\0',
  });
  const snapshot = await resolveGitStatusSnapshot('/repo', { spawn });
  assert.equal(snapshot.branch, 'a1b2c3d');
  assert.equal(snapshot.isDetached, true);
  assert.equal(snapshot.isGitRepository, true);
});

test('S04 non-git directory yields isGitRepository false and empty branch', async () => {
  const spawn = fakeSpawn({
    'symbolic-ref --short HEAD': new Error('not a git repository'),
    'rev-parse --short HEAD': new Error('not a git repository'),
    'status --porcelain=v1 -z': new Error('not a git repository'),
  });
  const snapshot = await resolveGitStatusSnapshot('/not-a-repo', { spawn });
  assert.equal(snapshot.isGitRepository, false);
  assert.equal(snapshot.branch, '');
  assert.equal(snapshot.uncommittedCount, 0);
  assert.equal(snapshot.isDetached, false);
});

test('S22 repo with no commits yet: symbolic-ref fails, rev-parse fails, status reports untracked only', async () => {
  const spawn = fakeSpawn({
    'symbolic-ref --short HEAD': new Error('no commits'),
    'rev-parse --short HEAD': new Error('no commits'),
    'status --porcelain=v1 -z': ['?? new-file.ts'].join('\0') + '\0',
  });
  const snapshot = await resolveGitStatusSnapshot('/empty-repo', { spawn });
  assert.equal(snapshot.branch, '');
  assert.equal(snapshot.isDetached, false);
  assert.equal(snapshot.isGitRepository, true);
  assert.equal(snapshot.uncommittedCount, 1);
});

test('count formula counts modified+added+deleted+untracked, never staged bucket', async () => {
  const spawn = fakeSpawn({
    'symbolic-ref --short HEAD': 'develop\n',
    'status --porcelain=v1 -z': [
      'A  staged-add.ts', // added (index A) -> also in `added`
      'D  staged-del.ts', // deleted (index D) -> also in `deleted`
      ' M mod.ts', // unstaged modified
      '?? untracked.ts',
    ].join('\0') + '\0',
  });
  const snapshot = await resolveGitStatusSnapshot('/repo', { spawn });
  // modified=1, added=1, deleted=1, untracked=1 => 4. The staged bucket is not
  // added on top of these; the parser's buckets already capture the files once.
  assert.equal(snapshot.uncommittedCount, 4);
});

test('S20 malformed .git/HEAD: both resolvers fail, status fails -> non-repo snapshot, no throw', async () => {
  const spawn = fakeSpawn({
    'symbolic-ref --short HEAD': new Error('malformed'),
    'rev-parse --short HEAD': new Error('malformed'),
    'status --porcelain=v1 -z': new Error('malformed'),
  });
  const snapshot = await resolveGitStatusSnapshot('/malformed', { spawn });
  assert.equal(snapshot.isGitRepository, false);
  // Must not throw and must not render a bogus branch name.
  assert.equal(snapshot.branch, '');
});

test('buildGitStatusEvent fills transport fields and keeps snapshot payload', () => {
  const event: GitStatusEvent = buildGitStatusEvent('proj-1', {
    branch: 'develop',
    uncommittedCount: 3,
    isDetached: false,
    isGitRepository: true,
  }, '2026-08-14T00:00:00.000Z');
  assert.equal(event.kind, 'git_status_changed');
  assert.equal(event.projectId, 'proj-1');
  assert.equal(event.branch, 'develop');
  assert.equal(event.uncommittedCount, 3);
  assert.equal(event.isDetached, false);
  assert.equal(event.isGitRepository, true);
  assert.equal(event.timestamp, '2026-08-14T00:00:00.000Z');
});
