import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import providerRoutes from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code });
      return;
    }

    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase([]);

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('Pi auth status route accepts the registered provider', { concurrency: false }, async () => {
  const previousCliPath = process.env.PI_CLI_PATH;
  process.env.PI_CLI_PATH = path.join(os.tmpdir(), 'cloudcli-test-missing-pi-cli');

  const app = express();
  app.use('/api/providers', providerRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/providers/pi/auth/status`,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: {
        installed: false,
        provider: 'pi',
        authenticated: false,
        email: null,
        method: null,
        error: 'Pi CLI not installed',
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousCliPath === undefined) {
      delete process.env.PI_CLI_PATH;
    } else {
      process.env.PI_CLI_PATH = previousCliPath;
    }
  }
});

test('session details route qualifies a provider-native id with the requested provider', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const nativeSessionId = 'shared-native-session';
    const claudeSessionId = sessionsDb.createAppSession(
      'route-app-session-claude',
      'claude',
      '/home/user/route-claude-project',
    );
    sessionsDb.assignProviderSessionId(claudeSessionId, nativeSessionId, 'claude');

    const codexSessionId = sessionsDb.createAppSession(
      'route-app-session-codex',
      'codex',
      '/home/user/route-codex-project',
    );
    sessionsDb.assignProviderSessionId(codexSessionId, nativeSessionId, 'codex');

    await withProviderServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/providers/sessions/${encodeURIComponent(nativeSessionId)}?provider=claude`,
      );

      assert.equal(response.status, 200);
      const payload = await response.json() as {
        data?: { sessionId?: string; provider?: string };
      };
      assert.equal(payload.data?.sessionId, claudeSessionId);
      assert.equal(payload.data?.provider, 'claude');

      const codexResponse = await fetch(
        `${baseUrl}/api/providers/sessions/${encodeURIComponent(nativeSessionId)}?provider=codex`,
      );

      assert.equal(codexResponse.status, 200);
      const codexPayload = await codexResponse.json() as {
        data?: { sessionId?: string; provider?: string };
      };
      assert.equal(codexPayload.data?.sessionId, codexSessionId);
      assert.equal(codexPayload.data?.provider, 'codex');
    });
  });
});

test('session details route rejects a lookup without a provider', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const sessionId = sessionsDb.createAppSession(
      'route-session-without-provider',
      'claude',
      '/home/user/route-missing-provider-project',
    );

    await withProviderServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/providers/sessions/${encodeURIComponent(sessionId)}`,
      );

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'PROVIDER_REQUIRED' });
    });
  });
});

test('models route rejects an uninstalled provider with the auth gate error', { concurrency: false }, async () => {
  const previousCliPath = process.env.PI_CLI_PATH;
  process.env.PI_CLI_PATH = path.join(os.tmpdir(), 'cloudcli-test-missing-pi-cli');

  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/pi/models`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'PROVIDER_NOT_AUTHENTICATED' });
  });

  if (previousCliPath === undefined) {
    delete process.env.PI_CLI_PATH;
  } else {
    process.env.PI_CLI_PATH = previousCliPath;
  }
});

test('active-model route rejects an unauthenticated provider with the auth gate error', { concurrency: false }, async () => {
  const previousCliPath = process.env.PI_CLI_PATH;
  process.env.PI_CLI_PATH = path.join(os.tmpdir(), 'cloudcli-test-missing-pi-cli');

  await withProviderServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/providers/pi/sessions/session-1/active-model`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'pi-model' }),
      },
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'PROVIDER_NOT_AUTHENTICATED' });
  });

  if (previousCliPath === undefined) {
    delete process.env.PI_CLI_PATH;
  } else {
    process.env.PI_CLI_PATH = previousCliPath;
  }
});

test('models route keeps the existing UNSUPPORTED_PROVIDER error for unregistered providers', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/nonexistent/models`);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'UNSUPPORTED_PROVIDER' });
  });
});
