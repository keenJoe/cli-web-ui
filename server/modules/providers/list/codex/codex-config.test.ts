import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodexConfig,
  normalizeModelsEndpoint,
} from '@/modules/providers/list/codex/codex-config.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
}

const writeConfig = (dir: string, content: string): string => {
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, content);
  return configPath;
};

const withEnv = async (
  key: string,
  value: string,
  run: () => void | Promise<void>,
): Promise<void> => {
  const saved = process.env[key];
  process.env[key] = value;
  try {
    await run();
  } finally {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
};

test('normalizeModelsEndpoint strips a trailing /v1 before appending /v1/models', () => {
  assert.equal(
    normalizeModelsEndpoint('https://aiapi.tcredit.com/v1'),
    'https://aiapi.tcredit.com/v1/models',
  );
});

test('normalizeModelsEndpoint appends /v1/models to bare base urls', () => {
  assert.equal(
    normalizeModelsEndpoint('https://aiapi.tcredit.com'),
    'https://aiapi.tcredit.com/v1/models',
  );
});

test('normalizeModelsEndpoint tolerates trailing slashes and a /v1/ suffix', () => {
  assert.equal(
    normalizeModelsEndpoint('https://aiapi.tcredit.com/'),
    'https://aiapi.tcredit.com/v1/models',
  );
  assert.equal(
    normalizeModelsEndpoint('https://aiapi.tcredit.com/v1/'),
    'https://aiapi.tcredit.com/v1/models',
  );
});

test('normalizeModelsEndpoint returns null for blank input', () => {
  assert.equal(normalizeModelsEndpoint(''), null);
  assert.equal(normalizeModelsEndpoint('   '), null);
});

test('load resolves model, active model_provider and its base_url and experimental_bearer_token', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(
      dir,
      [
        'model = "gpt-5.6-sol"',
        'model_provider = "tc-credit"',
        '[model_providers.tc-credit]',
        'base_url = "https://aiapi.tcredit.com/v1"',
        'experimental_bearer_token = "sk-test-token"',
        '',
      ].join('\n'),
    );

    const snapshot = await new CodexConfig(configPath).load();

    assert.ok(snapshot);
    assert.equal(snapshot.model, 'gpt-5.6-sol');
    assert.equal(snapshot.modelProvider, 'tc-credit');
    assert.equal(snapshot.baseUrl, 'https://aiapi.tcredit.com/v1');
    assert.deepEqual(snapshot.credential, {
      kind: 'experimental_bearer_token',
      value: 'sk-test-token',
    });
    assert.equal(
      normalizeModelsEndpoint(snapshot.baseUrl as string),
      'https://aiapi.tcredit.com/v1/models',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load resolves env_key credentials from the environment', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(
      dir,
      [
        'model = "gpt-5.6-sol"',
        'model_provider = "env-provider"',
        '[model_providers.env-provider]',
        'base_url = "https://env.example.com/v1"',
        'env_key = "CODEX_CONFIG_TEST_API_KEY"',
        '',
      ].join('\n'),
    );

    await withEnv('CODEX_CONFIG_TEST_API_KEY', 'sk-from-env', async () => {
      const snapshot = await new CodexConfig(configPath).load();
      assert.ok(snapshot);
      assert.deepEqual(snapshot.credential, {
        kind: 'env_key',
        envVar: 'CODEX_CONFIG_TEST_API_KEY',
        value: 'sk-from-env',
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load treats a missing env_key variable as no credential', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(
      dir,
      [
        'model_provider = "env-provider"',
        '[model_providers.env-provider]',
        'base_url = "https://env.example.com/v1"',
        'env_key = "CODEX_CONFIG_TEST_UNSET_VAR"',
        '',
      ].join('\n'),
    );

    const snapshot = await new CodexConfig(configPath).load();

    assert.ok(snapshot);
    assert.equal(snapshot.credential, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load resolves api_key credentials', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(
      dir,
      [
        'model_provider = "key-provider"',
        '[model_providers.key-provider]',
        'base_url = "https://key.example.com/v1"',
        'api_key = "sk-direct-key"',
        '',
      ].join('\n'),
    );

    const snapshot = await new CodexConfig(configPath).load();

    assert.ok(snapshot);
    assert.deepEqual(snapshot.credential, { kind: 'api_key', value: 'sk-direct-key' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load prefers experimental_bearer_token over api_key and env_key', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(
      dir,
      [
        'model_provider = "multi-provider"',
        '[model_providers.multi-provider]',
        'base_url = "https://multi.example.com/v1"',
        'experimental_bearer_token = "sk-bearer"',
        'api_key = "sk-api-key"',
        'env_key = "CODEX_CONFIG_TEST_API_KEY"',
        '',
      ].join('\n'),
    );

    await withEnv('CODEX_CONFIG_TEST_API_KEY', 'sk-from-env', async () => {
      const snapshot = await new CodexConfig(configPath).load();
      assert.ok(snapshot);
      assert.deepEqual(snapshot.credential, {
        kind: 'experimental_bearer_token',
        value: 'sk-bearer',
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load returns null when config.toml is missing', async () => {
  const dir = makeTempDir();
  try {
    const snapshot = await new CodexConfig(path.join(dir, 'missing-config.toml')).load();
    assert.equal(snapshot, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load returns null on invalid TOML', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(dir, 'model = "unterminated\n');
    const snapshot = await new CodexConfig(configPath).load();
    assert.equal(snapshot, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load exposes the model field without an active provider', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(dir, 'model = "gpt-5.6-sol"\n');
    const snapshot = await new CodexConfig(configPath).load();

    assert.ok(snapshot);
    assert.equal(snapshot.model, 'gpt-5.6-sol');
    assert.equal(snapshot.modelProvider, undefined);
    assert.equal(snapshot.baseUrl, undefined);
    assert.equal(snapshot.credential, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load ignores blank credential fields', async () => {
  const dir = makeTempDir();
  try {
    const configPath = writeConfig(
      dir,
      [
        'model_provider = "blank-provider"',
        '[model_providers.blank-provider]',
        'base_url = "https://blank.example.com/v1"',
        'experimental_bearer_token = ""',
        'api_key = "  "',
        '',
      ].join('\n'),
    );

    const snapshot = await new CodexConfig(configPath).load();

    assert.ok(snapshot);
    assert.equal(snapshot.credential, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
