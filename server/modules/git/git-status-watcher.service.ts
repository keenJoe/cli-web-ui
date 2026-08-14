import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { projectsDb } from '@/modules/database/index.js';

import { buildGitStatusEvent, resolveGitStatusSnapshot } from './git-status.service.js';
import { gitStatusPublisher } from './git-status-publisher.service.js';

/**
 * Per-project chokidar watch targets. `.git/HEAD` covers branch switches;
 * `.git/refs/heads/**` covers local branch creation/deletion. Worktree files
 * are intentionally NOT watched — the spec forbids polling the worktree, so the
 * uncommitted count only refreshes on a `.git` event or a frontend REST re-entry.
 */
const gitWatchGlobs = (projectPath: string): string[] => [
  path.join(projectPath, '.git', 'HEAD'),
  path.join(projectPath, '.git', 'refs', 'heads', '**'),
];

const DEBOUNCE_MS = 500;

type WatcherEntry = {
  watcher: FSWatcher;
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** Prevents duplicate hide broadcasts when both unlink and error fire. */
  hidePublished?: boolean;
};

const watchers = new Map<string, WatcherEntry>();

let disposed = false;

/**
 * Computes a snapshot for one project and broadcasts it through the publisher
 * port. Failures log and skip — the watcher is best-effort and never throws
 * into the chokidar event loop.
 */
async function broadcastStatus(projectId: string, projectPath: string): Promise<void> {
  try {
    const snapshot = await resolveGitStatusSnapshot(projectPath);
    gitStatusPublisher.publishGitStatusChanged(buildGitStatusEvent(projectId, snapshot));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Git status watcher failed to broadcast for project "${projectId}"`, {
      projectPath,
      error: message,
    });
  }
}

/**
 * Debounces a `.git` change for one project so a single checkout (which touches
 * both `.git/HEAD` and a refs/heads file) produces one status computation and
 * one broadcast rather than one per touched file.
 */
function scheduleBroadcast(projectId: string, projectPath: string, entry: WatcherEntry): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
  }
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = undefined;
    void broadcastStatus(projectId, projectPath);
  }, DEBOUNCE_MS);
}

/**
 * Publishes one hide event for a project unless one was already sent, so a
 * `.git` deletion (which fires both unlink and possibly error) does not
 * double-broadcast the same hide to clients.
 */
function publishHideOnce(projectId: string, entry: WatcherEntry): void {
  if (entry.hidePublished) {
    return;
  }
  entry.hidePublished = true;
  gitStatusPublisher.publishGitStatusChanged(
    buildGitStatusEvent(projectId, {
      branch: '',
      uncommittedCount: 0,
      isDetached: false,
      isGitRepository: false,
    }),
  );
}

/**
 * Starts one chokidar watcher for a single project. `ignoreInitial:true`
 * suppresses the startup flood (the frontend loads the first value via
 * `GET /api/git/status`); `usePolling:false` relies on native fs events since
 * `.git` is a tiny, low-churn directory.
 */
function startWatcher(projectId: string, projectPath: string): void {
  if (watchers.has(projectId) || disposed) {
    return;
  }

  const watcher = chokidar.watch(gitWatchGlobs(projectPath), {
    ignoreInitial: true,
    usePolling: false,
    followSymlinks: false,
    persistent: true,
  });

  const entry: WatcherEntry = { watcher };
  watchers.set(projectId, entry);

  watcher.on('change', () => {
    scheduleBroadcast(projectId, projectPath, entry);
  });

  watcher.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Git status watcher error for project "${projectId}"`, { projectPath, error: message });
    publishHideOnce(projectId, entry);
    void removeWatcher(projectId);
  });

  // `.git` deletion is surfaced as a watcher 'unlink' on the watched HEAD path;
  // treat it as "no longer a repository" and stop watching.
  watcher.on('unlink', () => {
    publishHideOnce(projectId, entry);
    void removeWatcher(projectId);
  });
}

async function removeWatcher(projectId: string): Promise<void> {
  const entry = watchers.get(projectId);
  if (!entry) {
    return;
  }
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
  }
  watchers.delete(projectId);
  try {
    await entry.watcher.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to close git status watcher for project "${projectId}"`, { error: message });
  }
}

/**
 * Diffs the current project list against active watchers, starting watchers
 * for new projects and stopping them for archived/removed ones. Called at
 * startup and after project create/archive so runtime-added projects get live
 * git status without a server restart.
 */
export function refreshGitStatusWatchers(): void {
  if (disposed) {
    return;
  }

  const currentProjects = projectsDb.getProjectPaths();
  const activeProjectIds = new Set<string>();

  for (const row of currentProjects) {
    if (!row.project_path) {
      continue;
    }
    activeProjectIds.add(row.project_id);
    if (!watchers.has(row.project_id)) {
      startWatcher(row.project_id, row.project_path);
    }
  }

  for (const projectId of watchers.keys()) {
    if (!activeProjectIds.has(projectId)) {
      void removeWatcher(projectId);
    }
  }
}

/**
 * Starts git status watchers for every non-archived project known at startup.
 */
export function initializeGitStatusWatcher(): void {
  disposed = false;
  console.log('Setting up git status watchers');
  refreshGitStatusWatchers();
}

/**
 * Stops all active git status watchers. Safe to call on server shutdown.
 */
export async function closeGitStatusWatcher(): Promise<void> {
  disposed = true;
  const entries = Array.from(watchers.keys());
  await Promise.all(entries.map((projectId) => removeWatcher(projectId)));
}
