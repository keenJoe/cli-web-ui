import assert from 'node:assert/strict';
import test from 'node:test';

import { webSocketGitStatusPublisher } from '@/modules/websocket/services/git-status-websocket-publisher.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { GitStatusEvent } from '@/shared/types.js';

class FakeConnection {
  readonly frames: Array<Record<string, unknown>> = [];

  constructor(readonly readyState: number) {}

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

const sampleEvent = (overrides: Partial<GitStatusEvent> = {}): GitStatusEvent => ({
  kind: 'git_status_changed',
  projectId: 'proj-1',
  branch: 'develop',
  uncommittedCount: 3,
  isDetached: false,
  isGitRepository: true,
  timestamp: '2026-08-14T00:00:00.000Z',
  ...overrides,
});

test.afterEach(() => {
  connectedClients.clear();
});

test('S19 git status adapter broadcasts to every open client and skips non-open', () => {
  const openClient = new FakeConnection(WS_OPEN_STATE);
  const otherOpen = new FakeConnection(WS_OPEN_STATE);
  const closingClient = new FakeConnection(2);
  const closedClient = new FakeConnection(3);
  connectedClients.add(openClient as never);
  connectedClients.add(otherOpen as never);
  connectedClients.add(closingClient as never);
  connectedClients.add(closedClient as never);

  webSocketGitStatusPublisher.publishGitStatusChanged(sampleEvent({ branch: 'feature' }));

  assert.equal(openClient.frames.length, 1);
  assert.equal(otherOpen.frames.length, 1);
  assert.equal(closingClient.frames.length, 0, 'closing client receives nothing');
  assert.equal(closedClient.frames.length, 0, 'closed client receives nothing');
});

test('payload is the GitStatusEvent JSON including the kind discriminator', () => {
  const openClient = new FakeConnection(WS_OPEN_STATE);
  connectedClients.add(openClient as never);

  webSocketGitStatusPublisher.publishGitStatusChanged(
    sampleEvent({
      branch: 'a1b2c3d',
      uncommittedCount: 0,
      isDetached: true,
      isGitRepository: true,
    }),
  );

  assert.deepEqual(openClient.frames[0], {
    kind: 'git_status_changed',
    projectId: 'proj-1',
    branch: 'a1b2c3d',
    uncommittedCount: 0,
    isDetached: true,
    isGitRepository: true,
    timestamp: '2026-08-14T00:00:00.000Z',
  });
});

test('broadcast with no open clients completes without throwing', () => {
  const closedClient = new FakeConnection(3);
  connectedClients.add(closedClient as never);

  assert.doesNotThrow(() =>
    webSocketGitStatusPublisher.publishGitStatusChanged(sampleEvent()),
  );
  assert.equal(closedClient.frames.length, 0);
});
