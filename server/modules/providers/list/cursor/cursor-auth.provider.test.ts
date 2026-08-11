import assert from 'node:assert/strict';
import test from 'node:test';

import spawn from 'cross-spawn';

import { CursorProviderAuth } from './cursor-auth.provider.js';

test('reports not installed when the version probe fails with ENOENT', async (t) => {
  t.mock.method(spawn, 'sync', () => ({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' }),
  }));

  assert.deepEqual(await new CursorProviderAuth().getStatus(), {
    installed: false,
    provider: 'cursor',
    authenticated: false,
    email: null,
    method: null,
    error: 'Cursor CLI is not installed',
  });
});

test('reports unauthenticated when Cursor cannot resolve the logged-in user', async () => {
  const auth = new CursorProviderAuth({
    checkInstalled: () => true,
    readLoginStatus: async () => ({
      code: 0,
      stdout: 'Login successful!\nLogged in (unable to fetch user details)\n',
      stderr: '',
    }),
  });

  assert.deepEqual(await auth.getStatus(), {
    installed: true,
    provider: 'cursor',
    authenticated: false,
    email: null,
    method: null,
    error: 'Unable to verify Cursor account details',
  });
});
