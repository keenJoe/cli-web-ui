import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeModelsFingerprint } from '@/shared/utils.js';

import {
  ClaudeProviderModels,
  CLAUDE_FALLBACK_MODELS,
} from './claude-models.provider.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-models-'));
}

const writeSettings = (dir: string, env: Record<string, string>): string => {
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ env }));
  return settingsPath;
};

const okJsonResponse = (body: unknown) => ({
  ok: true,
  json: async () => body,
}) as Response;

const testUrl = 'https://aiapi.example.com';
const testFingerprint = computeModelsFingerprint({
  baseUrl: testUrl,
  credential: 'sk-test-api-key',
});

test('claude supported models come from the configured settings API with a cacheable fingerprint', async (t) => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, {
      ANTHROPIC_BASE_URL: testUrl,
      ANTHROPIC_API_KEY: 'sk-test-api-key',
    });
    const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
      okJsonResponse({
        data: [
          { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { id: 'claude-haiku-4' },
        ],
      }),
    );

    try {
      const provider = new ClaudeProviderModels({ settingsPath });
      const catalog = await provider.getSupportedModels();

      assert.equal(catalog.cacheable, true);
      assert.deepEqual(
        catalog.models.OPTIONS.map((option) => option.value),
        ['claude-opus-5', 'claude-haiku-4'],
      );
      assert.equal(catalog.models.DEFAULT, 'claude-opus-5');
      assert.equal(catalog.fingerprint, testFingerprint);

      assert.equal(mockFetch.mock.calls.length, 1);
      const [url, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
      assert.equal(url, `${testUrl}/v1/models`);
      assert.deepEqual(init.headers, {
        'x-api-key': 'sk-test-api-key',
        'anthropic-version': '2023-06-01',
      });
    } finally {
      mockFetch.mock.restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude with ANTHROPIC_AUTH_TOKEN sends a Bearer header', async (t) => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, {
      ANTHROPIC_BASE_URL: testUrl,
      ANTHROPIC_AUTH_TOKEN: 'tok-test',
    });
    const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
      okJsonResponse({ data: [{ id: 'claude-opus-5' }] }),
    );

    try {
      const provider = new ClaudeProviderModels({ settingsPath });
      const catalog = await provider.getSupportedModels();

      assert.deepEqual(
        catalog.models.OPTIONS.map((option) => option.value),
        ['claude-opus-5'],
      );
      assert.equal(catalog.fingerprint, computeModelsFingerprint({
        baseUrl: testUrl,
        credential: 'tok-test',
      }));

      assert.equal(mockFetch.mock.calls.length, 1);
      const [url, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
      assert.equal(url, `${testUrl}/v1/models`);
      assert.deepEqual(init.headers, {
        Authorization: 'Bearer tok-test',
        'anthropic-version': '2023-06-01',
      });
    } finally {
      mockFetch.mock.restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude falls back to the built-in list with cacheable false when the API fails', async (t) => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, {
      ANTHROPIC_BASE_URL: testUrl,
      ANTHROPIC_API_KEY: 'sk-test-api-key',
    });
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as Response);

    try {
      const provider = new ClaudeProviderModels({ settingsPath });
      const catalog = await provider.getSupportedModels();

      assert.equal(catalog.models, CLAUDE_FALLBACK_MODELS);
      assert.equal(catalog.cacheable, false);
      assert.equal(catalog.fingerprint, testFingerprint);
    } finally {
      t.mock.restoreAll();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude with a key but no base_url falls back without fetching', async (t) => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, { ANTHROPIC_API_KEY: 'sk-test-api-key' });
    const mockFetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('network must not be touched');
    });

    try {
      const provider = new ClaudeProviderModels({ settingsPath });
      const catalog = await provider.getSupportedModels();

      assert.equal(catalog.models, CLAUDE_FALLBACK_MODELS);
      assert.equal(catalog.fingerprint, '');
      assert.equal(catalog.cacheable, true);
      assert.equal(mockFetch.mock.calls.length, 0);
    } finally {
      mockFetch.mock.restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude falls back to the built-in list when the configured API request fails (timeout/network error)', async (t) => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, {
      ANTHROPIC_BASE_URL: testUrl,
      ANTHROPIC_API_KEY: 'sk-test-api-key',
    });
    const mockFetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed (simulated network timeout)');
    });

    try {
      const provider = new ClaudeProviderModels({ settingsPath });
      const catalog = await provider.getSupportedModels();

      assert.equal(catalog.models, CLAUDE_FALLBACK_MODELS);
      assert.equal(catalog.cacheable, false);
      assert.equal(catalog.fingerprint, testFingerprint);
      assert.equal(mockFetch.mock.calls.length, 1);
    } finally {
      mockFetch.mock.restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude falls back to the built-in list on a malformed API response', async (t) => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, {
      ANTHROPIC_BASE_URL: testUrl,
      ANTHROPIC_API_KEY: 'sk-test-api-key',
    });
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async (): Promise<unknown> => { throw new SyntaxError('bad json'); },
    }) as Response);

    try {
      const provider = new ClaudeProviderModels({ settingsPath });
      const catalog = await provider.getSupportedModels();

      assert.equal(catalog.models, CLAUDE_FALLBACK_MODELS);
      assert.equal(catalog.cacheable, false);
      assert.equal(catalog.fingerprint, testFingerprint);
    } finally {
      t.mock.restoreAll();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude without settings keeps the built-in list', async (t) => {
  const dir = makeTempDir();
  try {
    const provider = new ClaudeProviderModels({
      settingsPath: path.join(dir, 'missing-settings.json'),
    });
    const catalog = await provider.getSupportedModels();

    assert.equal(catalog.models, CLAUDE_FALLBACK_MODELS);
    assert.equal(catalog.fingerprint, '');
    assert.equal(catalog.cacheable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude cached catalog fingerprint matches the fingerprint getSupportedModels returns', async (t) => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, {
      ANTHROPIC_BASE_URL: testUrl,
      ANTHROPIC_API_KEY: 'sk-test-api-key',
    });
    const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
      okJsonResponse({ data: [{ id: 'claude-opus-5' }] }),
    );

    try {
      const provider = new ClaudeProviderModels({ settingsPath });
      const catalog = await provider.getSupportedModels();

      assert.notEqual(catalog.fingerprint, '');
      assert.equal(provider.getCachedCatalogFingerprint(), catalog.fingerprint);
    } finally {
      mockFetch.mock.restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude without settings keeps an empty cached catalog fingerprint', () => {
  const dir = makeTempDir();
  try {
    const provider = new ClaudeProviderModels({
      settingsPath: path.join(dir, 'missing-settings.json'),
    });

    assert.equal(provider.getCachedCatalogFingerprint(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
