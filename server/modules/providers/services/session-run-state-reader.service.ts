import type { ISessionRunStateReader } from '@/shared/interfaces.js';

type RunningSession = ReturnType<ISessionRunStateReader['listRunningSessions']>[number];

class UnconfiguredSessionRunStateReader implements ISessionRunStateReader {
  listRunningSessions(): RunningSession[] {
    throw new Error('Session run-state reader has not been configured.');
  }
}

class InMemorySessionRunStateReader implements ISessionRunStateReader {
  constructor(private readonly runningSessions: RunningSession[]) {}

  listRunningSessions(): RunningSession[] {
    return this.runningSessions.map((session) => ({ ...session }));
  }
}

let configuredReader: ISessionRunStateReader = new UnconfiguredSessionRunStateReader();

/**
 * Used by provider route tests to supply active run summaries without importing
 * or mutating the WebSocket run registry.
 */
export function createInMemorySessionRunStateReader(
  runningSessions: RunningSession[] = [],
): ISessionRunStateReader {
  return new InMemorySessionRunStateReader(runningSessions);
}

/**
 * Used by the server assembly root and isolated tests to install the active
 * run-state adapter. The returned cleanup restores the preceding adapter.
 */
export function configureSessionRunStateReader(
  reader: ISessionRunStateReader,
): () => void {
  const previousReader = configuredReader;
  configuredReader = reader;
  let restored = false;

  return () => {
    if (restored) {
      return;
    }
    restored = true;
    if (configuredReader === reader) {
      configuredReader = previousReader;
    }
  };
}

/**
 * Used by the provider sessions service as the stable application-owned input
 * port; configuration swaps adapters without changing its consumers.
 */
export const sessionRunStateReader: ISessionRunStateReader = {
  listRunningSessions(): RunningSession[] {
    return configuredReader.listRunningSessions();
  },
};
