import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentModule } from '@/modules/agent/agent.module.js';

test('Agent module assembles from the generic runtime gateway', () => {
  const runtime = {
    hasRuntime: () => true,
    run: async () => ({ status: 'completed', providerSessionId: null, exitCode: 0 }),
    abortRun: async () => false,
  };

  assert.doesNotThrow(() => createAgentModule(runtime as never));
});
