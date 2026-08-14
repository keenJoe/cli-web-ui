import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PiModelsProvider, type PiModelsProbe } from './pi-models.provider.js';

type ModelRow = { provider: string; id: string; contextWindow: number; reasoning: boolean };

const makeProbe = (models: ModelRow[], defaultModel?: string): PiModelsProbe => ({
  async getAvailableModels() {
    return models;
  },
  async getState() {
    return { model: defaultModel };
  },
});

// A path that never exists, so tests that don't care about the fingerprint
// get the empty value (same as an unconfigured Pi install) instead of reading
// the developer's real ~/.pi/agent/models.json.
const NON_EXISTENT_CONFIG_PATH = path.join(os.tmpdir(), 'pi-models-test-missing.json');

const makeProvider = (
  probe: PiModelsProbe,
  modelsConfigPath: string = NON_EXISTENT_CONFIG_PATH,
): PiModelsProvider =>
  new PiModelsProvider(
    { async withProbe(fn) { return fn(probe); } },
    { modelsConfigPath },
  );

// T10 — get_available_models probe → canonical 列表 + 默认，reasoning 有 effort。
test('T10 supported models are canonical with reasoning-only effort and state default', async () => {
  const provider = makeProvider(
    makeProbe(
      [
        { provider: 'anthropic', id: 'claude-sonnet', contextWindow: 200000, reasoning: true },
        { provider: 'openai', id: 'gpt-basic', contextWindow: 128000, reasoning: false },
      ],
      'openai/gpt-basic',
    ),
  );

  const catalog = await provider.getSupportedModels();

  assert.deepEqual(
    catalog.models.OPTIONS.map((o) => o.value),
    ['anthropic/claude-sonnet', 'openai/gpt-basic'],
  );

  const reasoningOption = catalog.models.OPTIONS.find((o) => o.value === 'anthropic/claude-sonnet');
  const plainOption = catalog.models.OPTIONS.find((o) => o.value === 'openai/gpt-basic');
  assert.ok(reasoningOption?.effort, 'reasoning model exposes thinking effort');
  assert.ok(reasoningOption.effort.values.length > 0);
  assert.equal(plainOption?.effort, undefined, 'non-reasoning model has no effort');

  assert.equal(catalog.models.DEFAULT, 'openai/gpt-basic');
  assert.equal(catalog.cacheable, true);
  assert.equal(catalog.fingerprint, '');
});

// T10 变体 — 无 state.model 时回退目录首项。
test('T10 default falls back to first option when state has no model', async () => {
  const provider = makeProvider(
    makeProbe([{ provider: 'anthropic', id: 'claude-a', contextWindow: 1, reasoning: false }]),
  );

  const catalog = await provider.getSupportedModels();
  assert.equal(catalog.models.DEFAULT, 'anthropic/claude-a');
});

// T11 — 未认证（probe 无模型）→ ERR-PI-NOT-AUTHENTICATED，不冒充空目录。
test('T11 empty probe surfaces PI_NOT_AUTHENTICATED instead of empty catalog', async () => {
  const provider = makeProvider(makeProbe([]));
  await assert.rejects(
    () => provider.getSupportedModels(),
    (err: unknown) => (err as { code?: string }).code === 'PI_NOT_AUTHENTICATED',
  );
});

// T11 — probe 抛错映射为 PI_NOT_AUTHENTICATED。
test('T11 probe failure maps to PI_NOT_AUTHENTICATED', async () => {
  const provider = new PiModelsProvider(
    {
      async withProbe() {
        throw new Error('spawn probe failed');
      },
    },
    { modelsConfigPath: NON_EXISTENT_CONFIG_PATH },
  );
  await assert.rejects(
    () => provider.getSupportedModels(),
    (err: unknown) => (err as { code?: string }).code === 'PI_NOT_AUTHENTICATED',
  );
});

// getCurrentActiveModel 只读，回退目录默认。
test('getCurrentActiveModel returns catalog default', async () => {
  const provider = makeProvider(
    makeProbe(
      [{ provider: 'anthropic', id: 'claude-a', contextWindow: 1, reasoning: false }],
      'anthropic/claude-a',
    ),
  );
  const active = await provider.getCurrentActiveModel();
  assert.equal(active.model, 'anthropic/claude-a');
});

// models.json 内容驱动 fingerprint：内容变化 → fingerprint 变化；文件缺失 → 空。
test('getCachedCatalogFingerprint reflects models.json content and changes on edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-models-fp-'));
  const configPath = path.join(dir, 'models.json');

  fs.writeFileSync(configPath, JSON.stringify({ providers: { tcredit: { models: [{ id: 'glm-5.1' }] } } }));
  const provider = makeProvider(makeProbe([]), configPath);
  const fp1 = provider.getCachedCatalogFingerprint();
  assert.ok(fp1, 'configured models.json yields a non-empty fingerprint');

  // Reuse the same provider instance: fingerprint re-reads the file each call,
  // so an edited catalog invalidates the cache key without a new provider.
  fs.writeFileSync(configPath, JSON.stringify({ providers: { tcredit: { models: [{ id: 'glm-5.2' }] } } }));
  const fp2 = provider.getCachedCatalogFingerprint();
  assert.notEqual(fp1, fp2, 'fingerprint changes when models.json content changes');

  const missingProvider = makeProvider(makeProbe([]), path.join(dir, 'missing.json'));
  assert.equal(missingProvider.getCachedCatalogFingerprint(), '', 'missing file yields empty fingerprint');

  fs.rmSync(dir, { recursive: true, force: true });
});
