import assert from 'node:assert/strict';
import test from 'node:test';

import type { GitStatusEvent } from '@/shared/types.js';

import {
  configureGitStatusPublisher,
  createInMemoryGitStatusPublisher,
  gitStatusPublisher,
} from '../git-status-publisher.service.js';

const sampleEvent = (overrides: Partial<GitStatusEvent> = {}): GitStatusEvent => ({
  kind: 'git_status_changed',
  projectId: 'proj-1',
  branch: 'develop',
  uncommittedCount: 2,
  isDetached: false,
  isGitRepository: true,
  timestamp: '2026-08-14T00:00:00.000Z',
  ...overrides,
});

test('unconfigured publisher throws when called before configure', () => {
  const restore = configureGitStatusPublisher(createInMemoryGitStatusPublisher());
  restore();
  assert.throws(
    () => gitStatusPublisher.publishGitStatusChanged(sampleEvent()),
    /Git status publisher has not been configured/,
  );
});

test('configure installs an adapter that receives published events', () => {
  const inMemory = createInMemoryGitStatusPublisher();
  const restore = configureGitStatusPublisher(inMemory);

  gitStatusPublisher.publishGitStatusChanged(sampleEvent({ branch: 'feature' }));

  assert.equal(inMemory.events.length, 1);
  assert.equal(inMemory.events[0].branch, 'feature');

  restore();
});

test('configure returns a cleanup that restores the previous adapter', () => {
  const first = createInMemoryGitStatusPublisher();
  const second = createInMemoryGitStatusPublisher();
  const restoreFirst = configureGitStatusPublisher(first);
  const restoreSecond = configureGitStatusPublisher(second);

  gitStatusPublisher.publishGitStatusChanged(sampleEvent());
  assert.equal(second.events.length, 1, 'second adapter is active after second configure');
  assert.equal(first.events.length, 0, 'first adapter is no longer active');

  restoreSecond();
  gitStatusPublisher.publishGitStatusChanged(sampleEvent());
  assert.equal(first.events.length, 1, 'cleanup restores the first adapter');

  restoreFirst();
});

test('in-memory publisher collects events in order', () => {
  const inMemory = createInMemoryGitStatusPublisher();
  const restore = configureGitStatusPublisher(inMemory);

  gitStatusPublisher.publishGitStatusChanged(sampleEvent({ branch: 'a' }));
  gitStatusPublisher.publishGitStatusChanged(sampleEvent({ branch: 'b' }));
  gitStatusPublisher.publishGitStatusChanged(sampleEvent({ branch: 'c' }));

  assert.deepEqual(inMemory.events.map((e) => e.branch), ['a', 'b', 'c']);

  restore();
});
