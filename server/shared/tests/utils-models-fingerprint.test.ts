import assert from 'node:assert/strict';
import test from 'node:test';

import { computeModelsFingerprint } from '@/shared/utils.js';

test('computeModelsFingerprint returns a stable hash for the same configuration', () => {
  const input = {
    baseUrl: 'https://aiapi.tcredit.com/v1',
    credential: 'sk-test-token',
    modelProvider: 'tc-credit',
    model: 'gpt-5.6-sol',
  };

  const first = computeModelsFingerprint(input);
  const second = computeModelsFingerprint(input);

  assert.equal(typeof first, 'string');
  assert.ok(first.length > 0);
  assert.equal(first, second);
});

test('computeModelsFingerprint changes when base_url changes', () => {
  const base = {
    credential: 'sk-test-token',
    modelProvider: 'tc-credit',
    model: 'gpt-5.6-sol',
  };

  const fromA = computeModelsFingerprint({ ...base, baseUrl: 'https://gateway-a.example.com' });
  const fromB = computeModelsFingerprint({ ...base, baseUrl: 'https://gateway-b.example.com' });

  assert.notEqual(fromA, fromB);
});

test('computeModelsFingerprint changes when the credential changes', () => {
  const base = {
    baseUrl: 'https://aiapi.tcredit.com/v1',
    modelProvider: 'tc-credit',
    model: 'gpt-5.6-sol',
  };

  const withKeyA = computeModelsFingerprint({ ...base, credential: 'sk-token-a' });
  const withKeyB = computeModelsFingerprint({ ...base, credential: 'sk-token-b' });

  assert.notEqual(withKeyA, withKeyB);
});

test('computeModelsFingerprint changes when model_provider changes', () => {
  const base = {
    baseUrl: 'https://aiapi.tcredit.com/v1',
    credential: 'sk-test-token',
    model: 'gpt-5.6-sol',
  };

  const providerA = computeModelsFingerprint({ ...base, modelProvider: 'provider-a' });
  const providerB = computeModelsFingerprint({ ...base, modelProvider: 'provider-b' });

  assert.notEqual(providerA, providerB);
});

test('computeModelsFingerprint changes when the configured model changes', () => {
  const base = {
    baseUrl: 'https://aiapi.tcredit.com/v1',
    credential: 'sk-test-token',
    modelProvider: 'tc-credit',
  };

  const modelA = computeModelsFingerprint({ ...base, model: 'gpt-5.6-sol' });
  const modelB = computeModelsFingerprint({ ...base, model: 'gpt-5.6' });

  assert.notEqual(modelA, modelB);
});

test('computeModelsFingerprint never leaks the raw credential into the fingerprint', () => {
  const credential = 'sk-super-secret-credential';

  const fingerprint = computeModelsFingerprint({
    baseUrl: 'https://aiapi.tcredit.com/v1',
    credential,
    modelProvider: 'tc-credit',
    model: 'gpt-5.6-sol',
  });

  assert.ok(!fingerprint.includes(credential));
});

test('computeModelsFingerprint returns an empty fingerprint when no configuration is present', () => {
  assert.equal(computeModelsFingerprint({}), '');
});
