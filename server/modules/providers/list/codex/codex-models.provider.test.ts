import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeModelsFingerprint } from '@/shared/utils.js';

import {
  CodexProviderModels,
  CODEX_FALLBACK_MODELS,
} from './codex-models.provider.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-'));
}

const writeConfig = (dir: string, content: string): string => {
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, content);
  return configPath;
};

const writeModelsCache = (dir: string, models: unknown[]): string => {
  const cachePath = path.join(dir, 'models_cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({ models }));
  return cachePath;
};

const mockFetch = (response: unknown) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => response,
  }) as Response;
  return () => {
    globalThis.fetch = originalFetch;
  };
};

const makeConfig = (dir: string, extra = ''): string => writeConfig(
  dir,
  [
    'model = "gpt-5.6-sol"',
    'model_provider = "tc-credit"',
    '[model_providers.tc-credit]',
    'base_url = "https://aiapi.tcredit.com/v1"',
    'experimental_bearer_token = "sk-test-token"',
    extra,
    '',
  ].join('\n'),
);

test('codex supported models come from the configured API with a cacheable fingerprint', async () => {
  const dir = makeTempDir();
  try {
    const configPath = makeConfig(dir);
    const restore = mockFetch({
      data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.4', display_name: 'GPT-5.4' }],
    });

    try {
      const provider = new CodexProviderModels({ configPath, modelsCachePath: path.join(dir, 'missing-cache.json') });
      const catalog = await provider.getSupportedModels();

      assert.equal(catalog.cacheable, true);
      assert.deepEqual(
        catalog.models.OPTIONS.map((option) => option.value),
        ['gpt-5.6-sol', 'gpt-5.4'],
      );
      assert.equal(catalog.fingerprint, computeModelsFingerprint({
        baseUrl: 'https://aiapi.tcredit.com/v1',
        credential: 'sk-test-token',
        modelProvider: 'tc-credit',
        model: 'gpt-5.6-sol',
      }));
    } finally {
      restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex falls back to models_cache.json with cacheable false when the API fails', async () => {
  const dir = makeTempDir();
  try {
    const configPath = makeConfig(dir);
    const modelsCachePath = writeModelsCache(dir, [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 1 },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as Response;

    try {
      const provider = new CodexProviderModels({ configPath, modelsCachePath });
      const catalog = await provider.getSupportedModels();

      assert.equal(catalog.models.DEFAULT, 'gpt-5.5');
      assert.equal(catalog.cacheable, false);
      assert.equal(catalog.fingerprint, computeModelsFingerprint({
        baseUrl: 'https://aiapi.tcredit.com/v1',
        credential: 'sk-test-token',
        modelProvider: 'tc-credit',
        model: 'gpt-5.6-sol',
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex without configuration keeps the existing fallback chain with an empty fingerprint', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(dir, '\n');
    const modelsCachePath = writeModelsCache(dir, [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 1 },
    ]);

    const provider = new CodexProviderModels({ configPath, modelsCachePath });
    const catalog = await provider.getSupportedModels();

    assert.equal(catalog.models.DEFAULT, 'gpt-5.4');
    assert.equal(catalog.fingerprint, '');
    assert.equal(catalog.cacheable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex without configuration and without models_cache falls back to the built-in list', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(dir, '\n');

    const provider = new CodexProviderModels({
      configPath,
      modelsCachePath: path.join(dir, 'missing-cache.json'),
    });
    const catalog = await provider.getSupportedModels();

    assert.equal(catalog.models, CODEX_FALLBACK_MODELS);
    assert.equal(catalog.fingerprint, '');
    assert.equal(catalog.cacheable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex cached catalog fingerprint matches the fingerprint getSupportedModels returns', async () => {
  const dir = makeTempDir();
  try {
    const configPath = makeConfig(dir);
    const restore = mockFetch({
      data: [{ id: 'gpt-5.6-sol' }],
    });

    try {
      const provider = new CodexProviderModels({ configPath, modelsCachePath: path.join(dir, 'missing-cache.json') });
      const catalog = await provider.getSupportedModels();

      assert.notEqual(catalog.fingerprint, '');
      assert.equal(provider.getCachedCatalogFingerprint(), catalog.fingerprint);
    } finally {
      restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex without configuration keeps an empty cached catalog fingerprint', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(dir, '\n');

    const provider = new CodexProviderModels({
      configPath,
      modelsCachePath: path.join(dir, 'missing-cache.json'),
    });

    assert.equal(provider.getCachedCatalogFingerprint(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex with partial configuration falls back without entering the long-lived cache', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(dir, 'model = "gpt-5.6-sol"\n');
    const modelsCachePath = writeModelsCache(dir, [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 1 },
    ]);

    const provider = new CodexProviderModels({ configPath, modelsCachePath });
    const catalog = await provider.getSupportedModels();

    assert.equal(catalog.models.DEFAULT, 'gpt-5.4');
    assert.notEqual(catalog.fingerprint, '');
    assert.equal(catalog.cacheable, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
