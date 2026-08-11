import assert from 'node:assert/strict';
import test from 'node:test';

import spawn from 'cross-spawn';

import { ClaudeProviderAuth } from './claude-auth.provider.js';

test('reports not installed when the version probe fails with ENOENT', async (t) => {
  t.mock.method(spawn, 'sync', () => ({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
  }));

  assert.deepEqual(await new ClaudeProviderAuth().getStatus(), {
    installed: false,
    provider: 'claude',
    authenticated: false,
    email: null,
    method: null,
    error: 'Claude Code CLI is not installed',
  });
});
