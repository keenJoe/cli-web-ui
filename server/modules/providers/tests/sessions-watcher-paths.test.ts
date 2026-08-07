import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import chokidar, { type FSWatcher } from 'chokidar';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { PiPaths } from '@/modules/providers/list/pi/pi-paths.provider.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import {
  closeSessionsWatcher,
  initializeSessionsWatcher,
  resolveProviderWatchPaths,
} from '@/modules/providers/services/sessions-watcher.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import { getOpenCodeDatabasePath } from '@/shared/utils.js';

type WatcherListener = (filePath: string) => void;

test('watch paths are derived from registered provider synchronizers', (t) => {
  const roots = ['/registry-owned/primary', '/registry-owned/secondary'];
  const registeredProvider = {
    id: 'pi',
    sessionSynchronizer: {
      getWatchRoots: () => roots,
    },
  } as unknown as IProvider;
  t.mock.method(providerRegistry, 'listProviders', () => [registeredProvider]);

  assert.deepEqual(resolveProviderWatchPaths(), [
    { provider: 'pi', rootPath: roots[0] },
    { provider: 'pi', rootPath: roots[1] },
  ]);
});

test('registered synchronizers expose all Pi roots and the resolved OpenCode data root', () => {
  const watchedPaths = resolveProviderWatchPaths();

  assert.deepEqual(
    watchedPaths
      .filter(({ provider }) => provider === 'pi')
      .map(({ rootPath }) => rootPath),
    new PiPaths().getSessionRoots(),
  );
  assert.deepEqual(
    watchedPaths
      .filter(({ provider }) => provider === 'opencode')
      .map(({ rootPath }) => rootPath),
    [path.dirname(getOpenCodeDatabasePath())],
  );

  for (const provider of providerRegistry.listProviders()) {
    const synchronizerRoots = provider.sessionSynchronizer.getWatchRoots();
    assert.ok(
      synchronizerRoots.length > 0,
      `expected the ${provider.id} synchronizer to provide at least one watcher root`,
    );
    assert.deepEqual(
      watchedPaths
        .filter(({ provider: providerId }) => providerId === provider.id)
        .map(({ rootPath }) => rootPath),
      synchronizerRoots,
      `expected watcher roots to come from the ${provider.id} synchronizer`,
    );
  }
});

test('watcher delegates non-jsonl artifacts to the registered provider synchronizer', { concurrency: false }, async (t) => {
  const listeners = new Map<string, WatcherListener>();
  const receivedArtifacts: string[] = [];
  const rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'provider-watcher-artifacts-'));
  const artifactPath = path.join(rootPath, 'session.custom-artifact');
  const synchronizer = {
    getWatchRoots: () => [rootPath],
    synchronize: async () => 0,
    synchronizeFile: async (filePath: string) => {
      receivedArtifacts.push(filePath);
      return null;
    },
  };
  const registeredProvider = {
    id: 'pi',
    sessionSynchronizer: synchronizer,
  } as unknown as IProvider;
  const watcher = {
    on(eventName: string, listener: WatcherListener) {
      listeners.set(eventName, listener);
      return this;
    },
    close: async () => undefined,
  } as unknown as FSWatcher;

  t.mock.method(providerRegistry, 'listProviders', () => [registeredProvider]);
  t.mock.method(providerRegistry, 'resolveProvider', () => registeredProvider);
  t.mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => ({
    processedByProvider: {},
    failures: [],
  }));
  t.mock.method(chokidar, 'watch', () => watcher);

  try {
    await initializeSessionsWatcher();
    listeners.get('add')?.(artifactPath);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(receivedArtifacts, [artifactPath]);
  } finally {
    await closeSessionsWatcher();
    await fsPromises.rm(rootPath, { recursive: true, force: true });
  }
});
