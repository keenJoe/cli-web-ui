import { createHash } from 'node:crypto';

import spawn from 'cross-spawn';

import type { GitStatusEvent } from '@/shared/types.js';

import { parseGitStatusOutput } from './git-parsing.service.js';

/**
 * One project's git status as computed for the composer chip.
 *
 * `branch` is the short branch name, or the 7-character commit hash when
 * `isDetached` is true. `isGitRepository:false` means the directory is not a git
 * repository and the chip must hide. `uncommittedCount` excludes the staged
 * bucket to match the spec's display requirement.
 */
export type GitStatusSnapshot = Pick<
  GitStatusEvent,
  'branch' | 'uncommittedCount' | 'isDetached' | 'isGitRepository'
>;

/** Subprocess adapter signature matching `cross-spawn`'s default export. */
export type GitSpawn = typeof spawn;

/** Options for {@link resolveGitStatusSnapshot}. */
export type GitStatusServiceOptions = {
  /**
   * Override the `git` subprocess launcher. Tests inject a fake to drive
   * detached/clean/non-repo scenarios without spawning real git; production
   * leaves it unset to use `cross-spawn`.
   */
  spawn?: GitSpawn;
};

const GIT_SUBPROCESS_TIMEOUT_MS = 5_000;

/**
 * Runs `git <args>` in `cwd` and resolves with trimmed stdout. Rejects on a
 * non-zero exit code, spawn error, or the {@link GIT_SUBPROCESS_TIMEOUT_MS}
 * timeout so the watcher can skip this snapshot and keep running.
 */
function runGit(spawnFn: GitSpawn, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnFn('git', args, { cwd, shell: false });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';

    const stdout = child.stdout;
    const stderrStream = child.stderr;

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out after ${GIT_SUBPROCESS_TIMEOUT_MS}ms`));
    }, GIT_SUBPROCESS_TIMEOUT_MS);

    if (stdout) {
      stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    if (stderrStream) {
      stderrStream.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    }
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString());
        return;
      }
      const failure = new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr}`);
      (failure as Error & { code?: number; stderr?: string }).code = code ?? undefined;
      (failure as Error & { code?: number; stderr?: string }).stderr = stderr;
      reject(failure);
    });
  });
}

/**
 * Computes one project's git status snapshot by spawning `git`.
 *
 * Branch resolution prefers `symbolic-ref --short HEAD` (works even with no
 * commits); when that fails the repository is in detached HEAD and the 7-char
 * short hash from `rev-parse --short HEAD` is used with `isDetached:true`. If
 * every git invocation fails the directory is treated as a non-repository
 * (`isGitRepository:false`) rather than throwing, so the watcher broadcasts a
 * hide event instead of crashing.
 */
export async function resolveGitStatusSnapshot(
  projectPath: string,
  options: GitStatusServiceOptions = {},
): Promise<GitStatusSnapshot> {
  const spawnFn = options.spawn ?? spawn;

  try {
    let branch = '';
    let isDetached = false;

    try {
      branch = (await runGit(spawnFn, ['symbolic-ref', '--short', 'HEAD'], projectPath)).trim();
    } catch {
      // symbolic-ref fails on detached HEAD and on brand-new repos with no
      // commits yet; fall back to the short commit hash for the detached case.
      try {
        branch = (await runGit(spawnFn, ['rev-parse', '--short', 'HEAD'], projectPath)).trim();
        isDetached = true;
      } catch {
        // No commits at all: leave branch empty. The repo is still valid; the
        // status porcelain below still runs and reports untracked files.
      }
    }

    const statusOutput = await runGit(spawnFn, ['status', '--porcelain=v1', '-z'], projectPath);
    const { modified, added, deleted, untracked } = parseGitStatusOutput(statusOutput);

    return {
      branch,
      uncommittedCount: modified.length + added.length + deleted.length + untracked.length,
      isDetached,
      isGitRepository: true,
    };
  } catch {
    return {
      branch: '',
      uncommittedCount: 0,
      isDetached: false,
      isGitRepository: false,
    };
  }
}

/**
 * Builds a {@link GitStatusEvent} from a snapshot, filling in the transport
 * fields the snapshot deliberately omits so the watcher stays free of timestamp
 * / kind concerns.
 */
export function buildGitStatusEvent(
  projectId: string,
  snapshot: GitStatusSnapshot,
  timestamp: string = new Date().toISOString(),
): GitStatusEvent {
  return {
    kind: 'git_status_changed',
    projectId,
    branch: snapshot.branch,
    uncommittedCount: snapshot.uncommittedCount,
    isDetached: snapshot.isDetached,
    isGitRepository: snapshot.isGitRepository,
    timestamp,
  };
}
