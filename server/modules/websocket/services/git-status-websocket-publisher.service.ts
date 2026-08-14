import type { GitStatusEvent } from '@/shared/types.js';
import type { IGitStatusPublisher } from '@/shared/interfaces.js';

import { connectedClients, WS_OPEN_STATE } from './websocket-state.service.js';

/**
 * Production transport adapter for {@link IGitStatusPublisher}.
 *
 * The git status watcher hands each computed {@link GitStatusEvent} to this
 * adapter, which serializes it and writes it to every open chat websocket
 * connection. Connections that are not in the OPEN state are skipped silently:
 * the broadcast is best-effort and must never block or throw the watcher, and
 * half-open sockets are reaped by the heartbeat rather than here.
 *
 * Broadcasting to all authenticated clients mirrors {@link WebSocketSessionChangePublisher};
 * the frontend ChatComposer chip filters by `projectId`. Server-side per-project
 * membership filtering is intentionally out of scope for this change.
 */
export const webSocketGitStatusPublisher: IGitStatusPublisher = {
  publishGitStatusChanged(event: GitStatusEvent): void {
    const payload = JSON.stringify(event);
    connectedClients.forEach((client) => {
      if (client.readyState === WS_OPEN_STATE) {
        client.send(payload);
      }
    });
  },
};
