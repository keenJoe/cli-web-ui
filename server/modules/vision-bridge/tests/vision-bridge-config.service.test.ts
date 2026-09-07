import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  VisionBridgeModelCatalogPort,
} from '@/shared/types.js';
import { createVisionBridgeConfigRepository } from '../vision-bridge-config.repository.js';
import {
  createVisionBridgeConfigService,
  type VisionBridgeConfigServiceDependencies,
} from '../vision-bridge-config.service.js';
import type { VisionBridgeUpdateInputV1 } from '../../../../shared/vision-bridge.js';
import {
  VISION_BRIDGE_DEFAULT_PROMPT_TEMPLATE,
  VISION_BRIDGE_MODEL_NOT_VISION,
} from '../../../../shared/vision-bridge.js';

function makeService(
  overrides: Partial<VisionBridgeConfigServiceDependencies> = {},
): ReturnType<typeof createVisionBridgeConfigService> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-service-'));
  const repo = createVisionBridgeConfigRepository({ root });
  const catalog: VisionBridgeModelCatalogPort = {
    async listVisionModels() {
      return {
        available: true,
        models: [
          { provider: 'openai', id: 'gpt-4o-mini', credentialAvailable: true, apiKind: 'openai', supportsImage: true, reasoning: false },
          { provider: 'anthropic', id: 'claude-basic', credentialAvailable: false, apiKind: 'anthropic', supportsImage: true, reasoning: true },
        ],
      };
    },
  };

  return createVisionBridgeConfigService({
    repository: repo,
    modelCatalog: catalog,
    ...overrides,
  });
}

const VALID_UPDATE: VisionBridgeUpdateInputV1 = {
  enabled: true,
  visionModel: { provider: 'openai', id: 'gpt-4o-mini' },
  apiFormat: 'auto',
  maxImagesPerRun: 4,
  timeoutMs: 20000,
  concurrency: 2,
  maxTokens: 1024,
  promptTemplate: VISION_BRIDGE_DEFAULT_PROMPT_TEMPLATE,
  sources: { userImages: true, toolImages: false },
};

test('first read returns default disabled config', async () => {
  const service = makeService();
  const config = await service.getPublicConfig('user-1');
  assert.equal(config.enabled, false);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.sources.toolImages, false, 'tool images default off');
  assert.equal(config.maxImagesPerRun, 4);
  assert.equal(config.promptTemplate, VISION_BRIDGE_DEFAULT_PROMPT_TEMPLATE);
  assert.equal(config.visionModel, undefined);
});

test('save then read returns normalized public config', async () => {
  const service = makeService();
  const saved = await service.saveConfig('user-1', VALID_UPDATE);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.visionModel, { provider: 'openai', id: 'gpt-4o-mini' });
  assert.deepEqual(saved.visionModelAvailability, { available: true, credentialAvailable: true });

  const read = await service.getPublicConfig('user-1');
  assert.deepEqual(read, saved);
});

test('users are isolated', async () => {
  const service = makeService();
  await service.saveConfig('alice', VALID_UPDATE);
  const bob = await service.getPublicConfig('bob');
  assert.equal(bob.enabled, false, 'bob does not see alice config');
});

test('config validation rejects unknown fields', async () => {
  const service = makeService();
  await assert.rejects(
    () => service.saveConfig('u', { ...VALID_UPDATE, unknownField: true } as unknown as VisionBridgeUpdateInputV1),
    (err: unknown) => (err as { code?: number }).code === 4001,
  );
});

test('config validation rejects wrong schema version', async () => {
  const service = makeService();
  await assert.rejects(
    () =>
      service.saveConfig('u', {
        ...VALID_UPDATE,
        schemaVersion: 2,
      } as unknown as VisionBridgeUpdateInputV1),
    (err: unknown) => (err as { code?: number }).code === 4001,
  );
});

test('config validation rejects out-of-range numeric fields', async () => {
  const service = makeService();
  await assert.rejects(
    () => service.saveConfig('u', { ...VALID_UPDATE, maxImagesPerRun: 99 }),
    (err: unknown) => (err as { code?: number }).code === 4001,
  );
  await assert.rejects(
    () => service.saveConfig('u', { ...VALID_UPDATE, concurrency: 0 }),
    (err: unknown) => (err as { code?: number }).code === 4001,
  );
});

test('save rejects a non-vision model with ERR-VB-MODEL-NOT-VISION', async () => {
  const service = makeService();
  await assert.rejects(
    () =>
      service.saveConfig('u', {
        ...VALID_UPDATE,
        visionModel: { provider: 'openai', id: 'not-in-catalog' },
      }),
    (err: unknown) => (err as { code?: number }).code === VISION_BRIDGE_MODEL_NOT_VISION,
  );
});

test('save with unavailable model catalog maps to MODELS_UNAVAILABLE code', async () => {
  const service = makeService({
    modelCatalog: {
      async listVisionModels() {
        return { available: false, models: [] };
      },
    },
  });
  await assert.rejects(
    () => service.saveConfig('u', VALID_UPDATE),
    (err: unknown) => (err as { code?: number }).code === 5031,
  );
});

test('resolveLaunchPolicy returns disabled for missing userId', async () => {
  const service = makeService();
  const policy = await service.resolveLaunchPolicy(undefined);
  assert.equal(policy.enabled, false);
  assert.equal(policy.configPath, null);
  assert.ok(policy.diagnostics.length >= 0);
});

test('resolveLaunchPolicy returns disabled for null/empty userId', async () => {
  const service = makeService();
  for (const bad of [null, '']) {
    const policy = await service.resolveLaunchPolicy(bad as unknown as string);
    assert.equal(policy.enabled, false);
    assert.equal(policy.configPath, null);
  }
});

test('resolveLaunchPolicy returns enabled with path once saved', async () => {
  const service = makeService();
  await service.saveConfig('u', VALID_UPDATE);
  const policy = await service.resolveLaunchPolicy('u');
  assert.equal(policy.enabled, true);
  assert.ok(policy.configPath, 'configPath is set when enabled');
  assert.ok(path.isAbsolute(policy.configPath as string));
});

test('resolveLaunchPolicy disabled policy never throws on corrupt config', async () => {
  // Corrupt config on disk → service returns disabled with diagnostics.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-corrupt-'));
  const repo = createVisionBridgeConfigRepository({ root });
  const service = createVisionBridgeConfigService({
    repository: repo,
    modelCatalog: { async listVisionModels() { return { available: false, models: [] }; } },
  });
  // Write a corrupt config directly for the user we will resolve.
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update('corrupt-user').digest('hex');
  const dir = path.join(root, 'users', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ nope');

  const policy = await service.resolveLaunchPolicy('corrupt-user');
  assert.equal(policy.enabled, false);
  assert.equal(policy.configPath, null);
  assert.ok(policy.diagnostics.length > 0, 'corrupt config yields a diagnostic');
});

test('idempotent save returns same public config', async () => {
  const service = makeService();
  const first = await service.saveConfig('u', VALID_UPDATE);
  const second = await service.saveConfig('u', VALID_UPDATE);
  assert.deepEqual(first, second);
});

test('save missing model when enabled raises CONFIG_INVALID', async () => {
  const service = makeService();
  await assert.rejects(
    () => service.saveConfig('u', { ...VALID_UPDATE, visionModel: undefined }),
    (err: unknown) => (err as { code?: number }).code === 4001,
  );
});