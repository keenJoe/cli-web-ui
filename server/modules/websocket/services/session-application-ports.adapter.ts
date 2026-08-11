import type {
  ISessionChangePublisher,
  ISessionRunStateReader,
} from '@/shared/interfaces.js';

import { chatRunRegistry } from './chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from './websocket-state.service.js';

type SessionUpsertedEvent = Parameters<ISessionChangePublisher['publishSessionUpserted']>[0];
type RunningSession = ReturnType<ISessionRunStateReader['listRunningSessions']>[number];

class WebSocketSessionChangePublisher implements ISessionChangePublisher {
  publishSessionUpserted(event: SessionUpsertedEvent): void {
    const payload = JSON.stringify(event);
    connectedClients.forEach((client) => {
      if (client.readyState === WS_OPEN_STATE) {
        client.send(payload);
      }
    });
  }
}

class WebSocketSessionRunStateReader implements ISessionRunStateReader {
  listRunningSessions(): RunningSession[] {
    return chatRunRegistry.listRunningRuns();
  }
}

/**
 * Used by the server assembly root as the production transport adapter for
 * application-owned session change notifications.
 */
export const webSocketSessionChangePublisher: ISessionChangePublisher =
  new WebSocketSessionChangePublisher();

/**
 * Used by the server assembly root as the production adapter exposing active
 * chat-run summaries through the application read port.
 */
export const webSocketSessionRunStateReader: ISessionRunStateReader =
  new WebSocketSessionRunStateReader();
