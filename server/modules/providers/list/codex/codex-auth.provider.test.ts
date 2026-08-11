import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import spawn from 'cross-spawn';

import { CodexProviderAuth } from './codex-auth.provider.js';

const mockSpawnSync = (status: number) => () => ({
  pid: 0,
  output: [],
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  status,
  signal: null,
  error: undefined,
});

test('reports not installed when the version probe fails with ENOENT', async (t) => {
  t.mock.method(spawn, 'sync', () => ({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
  }));

  const status = await new CodexProviderAuth().getStatus();
  assert.equal(status.installed, false);
});

test('reports authenticated when config.toml has a gateway credential and auth.json has no valid token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'));
  const originalHomedir = os.homedir;
  try {
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'auth.json'), JSON.stringify({ tokens: {} }));
    fs.writeFileSync(
      path.join(dir, '.codex', 'config.toml'),
      [
        'model_provider = "tc-credit"',
        '[model_providers.tc-credit]',
        'base_url = "https://aiapi.tcredit.com/v1"',
        'experimental_bearer_token = "sk-test-token"',
        '',
      ].join('\n'),
    );
    (os as any).homedir = () => dir;

    t.mock.method(spawn, 'sync', mockSpawnSync(0));

    const status = await new CodexProviderAuth().getStatus();
    assert.equal(status.authenticated, true);
  } finally {
    (os as any).homedir = originalHomedir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reports authenticated when config.toml has a gateway credential and auth.json is missing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'));
  const originalHomedir = os.homedir;
  try {
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.codex', 'config.toml'),
      [
        'model = "gpt-5.6-sol"',
        'model_provider = "tc-credit"',
        '[model_providers.tc-credit]',
        'base_url = "https://aiapi.tcredit.com/v1"',
        'experimental_bearer_token = "sk-test-token"',
        '',
      ].join('\n'),
    );
    (os as any).homedir = () => dir;

    t.mock.method(spawn, 'sync', mockSpawnSync(0));

    const status = await new CodexProviderAuth().getStatus();
    assert.equal(status.authenticated, true);
  } finally {
    (os as any).homedir = originalHomedir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
