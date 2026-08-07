import type { ISessionChangePublisher } from '@/shared/interfaces.js';

type SessionUpsertedEvent = Parameters<ISessionChangePublisher['publishSessionUpserted']>[0];

class UnconfiguredSessionChangePublisher implements ISessionChangePublisher {
  publishSessionUpserted(_event: SessionUpsertedEvent): void {
    throw new Error('Session change publisher has not been configured.');
  }
}

class InMemorySessionChangePublisher implements ISessionChangePublisher {
  readonly events: SessionUpsertedEvent[] = [];

  publishSessionUpserted(event: SessionUpsertedEvent): void {
    this.events.push(event);
  }
}

let configuredPublisher: ISessionChangePublisher = new UnconfiguredSessionChangePublisher();

/**
 * Used by provider watcher tests to observe application session changes without
 * opening a WebSocket server or mutating the transport connection registry.
 */
export function createInMemorySessionChangePublisher(): ISessionChangePublisher & {
  readonly events: SessionUpsertedEvent[];
} {
  return new InMemorySessionChangePublisher();
}

/**
 * Used by the server assembly root and isolated tests to install the active
 * session-change adapter. The returned cleanup restores the preceding adapter.
 */
export function configureSessionChangePublisher(
  publisher: ISessionChangePublisher,
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
 * Used by provider session indexing services as the stable application-owned
 * output port; configuration swaps adapters without changing its consumers.
 */
export const sessionChangePublisher: ISessionChangePublisher = {
  publishSessionUpserted(event): void {
    configuredPublisher.publishSessionUpserted(event);
  },
};
