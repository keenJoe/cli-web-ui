import assert from 'node:assert/strict';
import test from 'node:test';

import { PiProvider } from './pi.provider.js';

test('PiProvider assembles only its supported IProvider facets with id "pi"', () => {
  const provider = new PiProvider();

  assert.equal(provider.id, 'pi');
  assert.ok(provider.runtime);
  assert.equal(typeof provider.runtime.run, 'function');
  assert.equal('abort' in provider.runtime, false);
  assert.ok(provider.models);
  assert.equal(typeof provider.models.getSupportedModels, 'function');
  assert.equal(provider.mcp, undefined);
  assert.ok(provider.auth);
  assert.equal(typeof provider.auth.getStatus, 'function');
  assert.ok(provider.skills);
  assert.equal(typeof provider.skills.listSkills, 'function');
  assert.ok(provider.usage);
  assert.equal(typeof provider.usage.getSessionTokenUsage, 'function');
  assert.ok(provider.sessions);
  assert.equal(typeof provider.sessions.normalizeMessage, 'function');
  assert.ok(provider.sessionSynchronizer);
  assert.equal(typeof provider.sessionSynchronizer.synchronize, 'function');
});
