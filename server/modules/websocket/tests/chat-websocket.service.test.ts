import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

class FakeSocket extends EventEmitter {
  readyState = 1;

  readonly frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'chat-websocket-boundary-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase([]);

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('chat.send ignores client-supplied native identity and uses the session row', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('fresh-app', 'pi', '/workspace/fresh');
    sessionsDb.createAppSession('resume-app', 'pi', '/workspace/resume');
    sessionsDb.assignProviderSessionId('resume-app', 'database-native', 'pi');

    const observedOptions: Array<Record<string, unknown>> = [];
    const runtime = {
      hasRuntime: () => true,
      async run(
        _provider: string,
        _command: string,
        options: Record<string, unknown>,
      ) {
        observedOptions.push(options);
        return { status: 'completed', providerSessionId: options.providerSessionId ?? null, exitCode: 0 };
      },
      async abort() {
        return false;
      },
      resolveToolApproval() {},
      getPendingApprovalsForSession: () => [],
    };

    for (const sessionId of ['fresh-app', 'resume-app']) {
      const socket = new FakeSocket();
      handleChatConnection(
        socket as never,
        { user: { id: 1 } } as AuthenticatedWebSocketRequest,
        { runtime: runtime as never },
      );
      socket.emit('message', JSON.stringify({
        type: 'chat.send',
        sessionId,
        content: 'Run',
        options: {
          providerSessionId: sessionId === 'fresh-app' ? 'client-native' : null,
        },
      }));

      while (observedOptions.length < (sessionId === 'fresh-app' ? 1 : 2)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      socket.emit('close');
    }

    assert.equal(observedOptions[0]?.providerSessionId, null);
    assert.equal(observedOptions[1]?.providerSessionId, 'database-native');
  });
});
