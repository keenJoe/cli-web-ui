import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from 'vite';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

test('sessionDetails includes the provider in its provider-native lookup request', async () => {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | null = null;

  try {
    globalThis.fetch = async (request) => {
      requestedUrl = String(request);
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const apiModule = await vite.ssrLoadModule('/src/utils/api.js');
    const api = apiModule.api as {
      sessionDetails: (sessionId: string, provider: string) => Promise<Response>;
    };

    await api.sessionDetails('native-session.1', 'claude');

    assert.equal(
      requestedUrl,
      '/api/providers/sessions/native-session.1?provider=claude',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});
