import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readClaudeSettings,
  resolveClaudeAuthHeader,
  resolveClaudeModelEndpoint,
} from '@/modules/providers/list/claude/claude-settings.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
}

const writeSettings = (dir: string, content: string): string => {
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, content);
  return settingsPath;
};

test('readClaudeSettings resolves base_url and api_key from settings env', async () => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(
      dir,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://aiapi.example.com',
          ANTHROPIC_API_KEY: 'sk-test-api-key',
        },
      }),
    );

    const snapshot = await readClaudeSettings(settingsPath);

    assert.ok(snapshot);
    assert.equal(snapshot.baseUrl, 'https://aiapi.example.com');
    assert.equal(snapshot.apiKey, 'sk-test-api-key');
    assert.equal(snapshot.authToken, undefined);
    assert.equal(snapshot.hasCredential, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readClaudeSettings treats api_key without base_url as missing config', async () => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(
      dir,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-test-api-key' } }),
    );
    assert.equal(await readClaudeSettings(settingsPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readClaudeSettings treats base_url without a credential as missing config', async () => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(
      dir,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://aiapi.example.com' } }),
    );
    assert.equal(await readClaudeSettings(settingsPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readClaudeSettings resolves the auth token alongside base_url', async () => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(
      dir,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://aiapi.example.com',
          ANTHROPIC_AUTH_TOKEN: 'tok-test',
        },
      }),
    );

    const snapshot = await readClaudeSettings(settingsPath);

    assert.ok(snapshot);
    assert.equal(snapshot.authToken, 'tok-test');
    assert.equal(snapshot.apiKey, undefined);
    assert.equal(snapshot.hasCredential, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readClaudeSettings returns null when settings.json is missing', async () => {
  const dir = makeTempDir();
  try {
    assert.equal(await readClaudeSettings(path.join(dir, 'missing-settings.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readClaudeSettings returns null on malformed JSON', async () => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, '{ not json');
    assert.equal(await readClaudeSettings(settingsPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readClaudeSettings returns null on an empty file', async () => {
  const dir = makeTempDir();
  try {
    const settingsPath = writeSettings(dir, '');
    assert.equal(await readClaudeSettings(settingsPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveClaudeModelEndpoint appends /v1/models to a bare base url', () => {
  assert.equal(
    resolveClaudeModelEndpoint('https://aiapi.example.com'),
    'https://aiapi.example.com/v1/models',
  );
});

test('resolveClaudeModelEndpoint does not duplicate a trailing /v1', () => {
  assert.equal(
    resolveClaudeModelEndpoint('https://aiapi.example.com/v1'),
    'https://aiapi.example.com/v1/models',
  );
  assert.equal(
    resolveClaudeModelEndpoint('https://aiapi.example.com/v1/'),
    'https://aiapi.example.com/v1/models',
  );
});

test('resolveClaudeAuthHeader maps api_key to the x-api-key header', () => {
  assert.deepEqual(resolveClaudeAuthHeader('sk-api-key', undefined), {
    header: 'x-api-key',
    value: 'sk-api-key',
  });
});

test('resolveClaudeAuthHeader maps auth token to an Authorization Bearer header', () => {
  assert.deepEqual(resolveClaudeAuthHeader(undefined, 'tok-test'), {
    header: 'Authorization',
    value: 'Bearer tok-test',
  });
});

test('resolveClaudeAuthHeader prefers the auth token when both are present', () => {
  assert.deepEqual(resolveClaudeAuthHeader('sk-api-key', 'tok-test'), {
    header: 'Authorization',
    value: 'Bearer tok-test',
  });
});
