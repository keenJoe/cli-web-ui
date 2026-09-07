import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPiVisionModelCatalogProvider,
  decodePiModelSnapshot,
} from '../index.js';

test('decoder reduces only models declaring image input', () => {
  const raw = {
    models: [
      {
        provider: 'openai',
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        api: 'openai-completions',
        baseUrl: 'https://api.openai.com/v1',
        input: ['text', 'image'],
        headers: { authorization: 'Bearer secret' },
      },
      { provider: 'anthropic', id: 'claude-text', input: ['text'] },
      { provider: 'openai', id: 'no-input-model', name: 'No Input' },
      'not-an-object',
      null,
    ],
  };

  const models = decodePiModelSnapshot(raw);

  assert.equal(models.length, 1, 'only the image-capable model enters the catalog');
  const [model] = models;
  assert.equal(model.provider, 'openai');
  assert.equal(model.id, 'gpt-4o-mini');
  assert.equal(model.displayName, 'GPT-4o mini');
  assert.equal(model.apiKind, 'openai-completions');
  assert.equal(model.credentialAvailable, true);
});

test('decoder never leaks baseUrl, headers, or api keys', () => {
  const raw = [
    {
      provider: 'openai',
      id: 'gpt-4o-mini',
      input: ['image'],
      baseUrl: 'https://secret.endpoint/v1',
      headers: { authorization: 'Bearer top-secret' },
      apiKey: 'sk-live',
    },
  ];

  const models = decodePiModelSnapshot(raw);
  assert.equal(models.length, 1);
  const serialized = JSON.stringify(models[0]);
  assert.ok(!serialized.includes('secret.endpoint'), 'baseUrl must not be returned');
  assert.ok(!serialized.includes('Bearer'), 'headers must not be returned');
  assert.ok(!serialized.includes('sk-live'), 'apiKey must not be returned');
});

test('decoder accepts a bare array or a {models} wrapper', () => {
  const bare = [{ provider: 'p', id: 'm', input: ['image'] }];
  assert.equal(decodePiModelSnapshot(bare).length, 1);
  assert.equal(decodePiModelSnapshot({ models: bare }).length, 1);
});

test('decoder returns empty for non-array snapshots', () => {
  assert.equal(decodePiModelSnapshot(undefined).length, 0);
  assert.equal(decodePiModelSnapshot('nope').length, 0);
  assert.equal(decodePiModelSnapshot({ models: 'nope' }).length, 0);
});

test('catalog provider caches a successful probe within the TTL window', async () => {
  let probeCalls = 0;
  const probe = async () => {
    probeCalls += 1;
    return [{ provider: 'p', id: 'vision', input: ['image'] }];
  };
  const port = createPiVisionModelCatalogProvider(probe);

  const first = await port.listVisionModels();
  const second = await port.listVisionModels();

  assert.equal(first.available, true);
  assert.equal(second.available, true);
  // The second read is served from the in-process cache, not a fresh probe.
  assert.equal(probeCalls, 1, 'successful probe is cached so a re-mount never spawns a new Pi child');
});

test('catalog provider does not cache a failed probe', async () => {
  let probeCalls = 0;
  const port = createPiVisionModelCatalogProvider(async () => {
    probeCalls += 1;
    throw new Error('pi unavailable');
  });

  assert.equal((await port.listVisionModels()).available, false);
  assert.equal((await port.listVisionModels()).available, false);
  assert.equal(probeCalls, 2, 'failures are retried, never cached');
});
