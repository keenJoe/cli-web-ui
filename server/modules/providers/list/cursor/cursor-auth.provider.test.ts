import assert from 'node:assert/strict';
import test from 'node:test';

import { CursorProviderAuth } from './cursor-auth.provider.js';

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
