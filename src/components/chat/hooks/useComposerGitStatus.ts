import { useEffect, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { authenticatedFetch } from '../../../utils/api';
import type { Project } from '../../../types/app';

/**
 * What the chip renders for one project. `isGitRepository:false` means the
 * project is not (or no longer is) a git repository, so the chip must hide.
 */
export type ComposerGitStatus = {
  branch: string;
  uncommittedCount: number;
  isDetached: boolean;
  isGitRepository: boolean;
};

// --------------------------- MODULE-LEVEL CACHE ---------------------------
// Shared across hook instances so switching from project A to B renders B's
// last-known status instantly (spec "多工程切换") before the REST reconcile
// resolves. Plain map; the hook drives React state from it.
const cache = new Map<string, ComposerGitStatus>();

function cacheStatus(projectId: string, status: ComposerGitStatus): void {
  cache.set(projectId, status);
}

// --------------------------- HOOK ---------------------------

/**
 * Returns the current git status for the composer chip.
 *
 * Subscribes to `git_status_changed` websocket frames for the selected
 * project, shows the cached value instantly on project switch, and
 * reconciles with `GET /api/git/status` on project entry and on websocket
 * reconnect (spec "兜底" + "多工程切换" + "WebSocket 断连"). The spec forbids
 * polling, so those two triggers are the only REST fetch points.
 */
export function useComposerGitStatus(selectedProject: Project | null): ComposerGitStatus | null {
  const { subscribe } = useWebSocket();
  const projectId = selectedProject?.projectId ?? null;
  const [status, setStatus] = useState<ComposerGitStatus | null>(() =>
    projectId ? (cache.get(projectId) ?? null) : null,
  );

  // On project switch: show the cached value instantly, then reconcile via
  // REST. A per-switch flag discards responses that arrive after the user
  // moves on to another project.
  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      return undefined;
    }
    let active = true;

    const cached = cache.get(projectId);
    if (cached) {
      setStatus(cached);
    }

    void (async () => {
      const next = await fetchGitStatus(projectId);
      if (active && next) {
        cacheStatus(projectId, next);
        setStatus(next);
      }
    })();

    return () => {
      active = false;
    };
  }, [projectId]);

  // Live websocket updates for the selected project, plus a REST refetch when
  // the socket reopens after a drop (the watcher only pushes on a `.git`
  // change, so reconnect reconciles any missed state per the design).
  useEffect(() => {
    if (!projectId) {
      return undefined;
    }
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'git_status_changed' && event.projectId === projectId) {
        const next: ComposerGitStatus = {
          branch: typeof event.branch === 'string' ? event.branch : '',
          uncommittedCount: typeof event.uncommittedCount === 'number' ? event.uncommittedCount : 0,
          isDetached: Boolean(event.isDetached),
          isGitRepository: event.isGitRepository !== false,
        };
        cacheStatus(projectId, next);
        setStatus(next);
      } else if (event.kind === 'websocket_reconnected') {
        void fetchGitStatus(projectId).then((next) => {
          if (next) {
            cacheStatus(projectId, next);
            setStatus(next);
          }
        });
      }
    });
    return unsubscribe;
  }, [subscribe, projectId]);

  return status;
}

/**
 * Fetches one project's status via the existing REST endpoint and normalizes
 * it to the chip shape. Resolves to `null` on failure so the caller keeps the
 * last known status instead of blanking the chip on a transient REST error.
 */
async function fetchGitStatus(projectId: string): Promise<ComposerGitStatus | null> {
  try {
    const response = await authenticatedFetch(
      `/api/git/status?project=${encodeURIComponent(projectId)}`,
    );
    const data = (await response.json()) as {
      branch?: string;
      modified?: unknown[];
      added?: unknown[];
      deleted?: unknown[];
      untracked?: unknown[];
      staged?: unknown[];
      notGitRepository?: boolean;
    };

    if (data.notGitRepository) {
      return { branch: '', uncommittedCount: 0, isDetached: false, isGitRepository: false };
    }

    const branch = typeof data.branch === 'string' ? data.branch : '';
    return {
      branch,
      uncommittedCount:
        (data.modified?.length ?? 0) +
        (data.added?.length ?? 0) +
        (data.deleted?.length ?? 0) +
        (data.untracked?.length ?? 0),
      // The REST endpoint reports 'HEAD' for detached HEAD (design E1); the WS
      // path supplies the real 7-char short hash on the next .git change.
      isDetached: branch === 'HEAD',
      isGitRepository: true,
    };
  } catch {
    return null;
  }
}
