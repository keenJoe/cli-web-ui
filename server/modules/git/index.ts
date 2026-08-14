// createGitModule: used by the server entrypoint to assemble Git routes with provider runtimes.
export { createGitModule } from './git.module.js';

// Git status watcher lifecycle (managed by the server assembly root) and the
// publisher port consumed by the watcher. Exported through this barrel so the
// server entrypoint can wire them without deep-importing git module internals.
export {
  initializeGitStatusWatcher,
  closeGitStatusWatcher,
  refreshGitStatusWatchers,
} from './git-status-watcher.service.js';
export {
  gitStatusPublisher,
  configureGitStatusPublisher,
  createInMemoryGitStatusPublisher,
} from './git-status-publisher.service.js';
export { resolveGitStatusSnapshot, buildGitStatusEvent } from './git-status.service.js';
export type { GitStatusSnapshot, GitStatusServiceOptions, GitSpawn } from './git-status.service.js';
