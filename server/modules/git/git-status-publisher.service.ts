import type { GitStatusEvent } from '@/shared/types.js';
import type { IGitStatusPublisher } from '@/shared/interfaces.js';

class UnconfiguredGitStatusPublisher implements IGitStatusPublisher {
  publishGitStatusChanged(_event: GitStatusEvent): void {
    throw new Error('Git status publisher has not been configured.');
  }
}

class InMemoryGitStatusPublisher implements IGitStatusPublisher {
  readonly events: GitStatusEvent[] = [];

  publishGitStatusChanged(event: GitStatusEvent): void {
    this.events.push(event);
  }
}

let configuredPublisher: IGitStatusPublisher = new UnconfiguredGitStatusPublisher();

/**
 * Used by git status watcher tests to observe broadcast events without opening a
 * WebSocket server or mutating the transport connection registry.
 */
export function createInMemoryGitStatusPublisher(): IGitStatusPublisher & {
  readonly events: GitStatusEvent[];
} {
  return new InMemoryGitStatusPublisher();
}

/**
 * Used by the server assembly root and isolated tests to install the active
 * git status broadcast adapter. The returned cleanup restores the preceding
 * adapter so tests do not leak configuration across each other.
 */
export function configureGitStatusPublisher(
  publisher: IGitStatusPublisher,
): () => void {
  const previousPublisher = configuredPublisher;
  configuredPublisher = publisher;
  let restored = false;

  return () => {
    if (restored) {
      return;
    }
    restored = true;
    if (configuredPublisher === publisher) {
      configuredPublisher = previousPublisher;
    }
  };
}

/**
 * Used by the git status watcher as the stable application-owned output port;
 * configuration swaps adapters without changing its consumers.
 */
export const gitStatusPublisher: IGitStatusPublisher = {
  publishGitStatusChanged(event: GitStatusEvent): void {
    configuredPublisher.publishGitStatusChanged(event);
  },
};
