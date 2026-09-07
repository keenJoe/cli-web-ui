import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildUpdateInput,
  canSaveConfig,
  createDefaultPublicConfig,
  parseConfigEnvelope,
  parseModelsEnvelope,
  pickPublicConfig,
  reduceSaveResult,
} from '../../../hooks/visionBridgeSettingsLogic';
import { VisionBridgeSettingsView } from './VisionBridgeSettingsView';
import type {
  VisionBridgeModelOptionV1,
  VisionBridgePublicConfigV1,
} from '../../../../../../shared/vision-bridge.js';

const hex = (n: number) => n.toString(16).padStart(64, '0');

const disabledDefault = createDefaultPublicConfig();

const modelA: VisionBridgeModelOptionV1 = {
  provider: 'openai',
  id: 'gpt-4o-mini',
  displayName: 'GPT-4o mini',
  apiKind: 'openai',
  credentialAvailable: true,
  supportsImage: true,
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 16384,
};

const modelB: VisionBridgeModelOptionV1 = {
  provider: 'anthropic',
  id: 'claude-3.5-vision',
  displayName: 'Claude 3.5 Vision',
  apiKind: 'anthropic',
  credentialAvailable: false,
  supportsImage: true,
  reasoning: true,
};

const enabledConfig = (overrides: Partial<VisionBridgePublicConfigV1> = {}): VisionBridgePublicConfigV1 => ({
  ...disabledDefault,
  enabled: true,
  visionModel: { provider: 'openai', id: 'gpt-4o-mini' },
  visionModelAvailability: { available: true, credentialAvailable: true },
  ...overrides,
});

test('default config is disabled and tool images are off', () => {
  const cfg = createDefaultPublicConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.sources.toolImages, false);
  assert.equal(cfg.sources.userImages, true);
  assert.equal(cfg.schemaVersion, 1);
});

test('pickPublicConfig strips secret fields but keeps the public endpoint URL', () => {
  const raw = {
    ...enabledConfig(),
    // Hostile fields that must never reach the form or logs:
    apiKey: 'leaked-api-key-12345',
    baseUrl: 'https://example.com/v1',
    authorization: 'Bearer secret-token',
    userId: 42,
    secret: 'shh-top-secret',
    configPath: '/home/user/.cloudcli/vision-bridge/users/abc/config.json',
    endpoint: 'https://api.openai.com/v1',
    headers: { 'x-api-key': 'leaked' },
  };

  const picked = pickPublicConfig(raw);

  assert.ok(picked, 'a valid config must be picked');
  const serialized = JSON.stringify(picked);
  for (const forbidden of [
    'leaked-api-key-12345',
    'secret-token',
    'shh-top-secret',
    'apiKey',
    'authorization',
    'userId',
    'secret',
    'configPath',
    'endpoint',
    'headers',
    '/.cloudcli/',
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `desensitization failed: "${forbidden}" leaked into public config`,
    );
  }
  // The picked config keeps the legitimate (non-secret) endpoint URL and model.
  assert.equal(picked!.baseUrl, 'https://example.com/v1');
  assert.equal(picked!.hasApiKey, false);
  assert.deepEqual(picked!.visionModel, { provider: 'openai', id: 'gpt-4o-mini' });
});

test('pickPublicConfig is idempotent — reopening a tab reads the same shape', () => {
  const picked = pickPublicConfig(enabledConfig());
  assert.ok(picked);
  const rePicked = pickPublicConfig(picked);
  assert.deepEqual(rePicked, picked);
});

test('parseConfigEnvelope returns the picked config on success and errorCode on failure', () => {
  const ok = parseConfigEnvelope({ success: true, data: enabledConfig() });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.enabled, true);
  }

  const fail = parseConfigEnvelope({ success: false, error: { code: 4001, message: 'bad' } });
  assert.equal(fail.ok, false);
  if (!fail.ok) {
    assert.equal(fail.errorCode, 4001);
  }
});

test('parseModelsEnvelope strips per-model secrets and keeps only safe fields', () => {
  const raw = {
    success: true,
    data: [
      { ...modelA, apiKey: 'leaked', headers: { authorization: 'leaked' } },
      modelB,
    ],
  };
  const parsed = parseModelsEnvelope(raw);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.models.length, 2);
    const serialized = JSON.stringify(parsed.models);
    assert.ok(!serialized.includes('leaked'));
    assert.ok(!serialized.includes('apiKey'));
    assert.ok(!serialized.includes('headers'));
    assert.deepEqual(parsed.models[0], modelA);
  }
});

test('canSaveConfig: disabled is always saveable; enabled needs a model with credentials', () => {
  // Disabled: always ok.
  assert.equal(canSaveConfig(disabledDefault, []).ok, true);

  // Enabled without a model.
  assert.equal(canSaveConfig({ ...enabledConfig(), visionModel: undefined }, []).ok, false);

  // Enabled with a model that vanished from the catalog.
  const vanished = canSaveConfig(
    { ...enabledConfig(), visionModel: { provider: 'openai', id: 'gone' } },
    [modelA],
  );
  assert.equal(vanished.ok, false);
  if (!vanished.ok) {
    assert.equal(vanished.reasonKey, 'blockedModelMissing');
  }

  // Enabled with a model whose credentials are unavailable.
  const noCred = canSaveConfig(
    { ...enabledConfig(), visionModel: { provider: 'anthropic', id: 'claude-3.5-vision' } },
    [modelB],
  );
  assert.equal(noCred.ok, false);
  if (!noCred.ok) {
    assert.equal(noCred.reasonKey, 'blockedCredential');
  }

  // Enabled with a valid, credentialed model.
  assert.equal(canSaveConfig(enabledConfig(), [modelA]).ok, true);
});

test('reduceSaveResult keeps the old config reference when the save fails', () => {
  const oldConfig = enabledConfig();
  const failEnvelope = { success: false, error: { code: 5002, message: 'write failed' } };
  const next = reduceSaveResult(oldConfig, failEnvelope);
  // Old config is preserved by reference — no half-written new state.
  assert.equal(next, oldConfig);
  assert.equal(next.enabled, true);
});

test('reduceSaveResult returns a freshly picked config (no secrets) on success', () => {
  const oldConfig = disabledDefault;
  const successEnvelope = {
    success: true,
    data: {
      ...enabledConfig(),
      apiKey: 'leaked-after-save',
      userId: 7,
    },
  };
  const next = reduceSaveResult(oldConfig, successEnvelope);
  assert.ok(next, 'a valid config must be returned on success');
  assert.notEqual(next, oldConfig);
  assert.equal(next!.enabled, true);
  assert.ok(!JSON.stringify(next).includes('leaked-after-save'));
});

test('buildUpdateInput drops schemaVersion and availability, keeps user fields', () => {
  const input = buildUpdateInput(enabledConfig());
  assert.equal(
    (input as unknown as Record<string, unknown>).schemaVersion,
    undefined,
  );
  assert.equal(
    (input as unknown as Record<string, unknown>).visionModelAvailability,
    undefined,
  );
  assert.equal(input.enabled, true);
  assert.deepEqual(input.visionModel, { provider: 'openai', id: 'gpt-4o-mini' });
  assert.equal(input.sources.toolImages, false);
  assert.equal(input.sources.userImages, true);
});

// ---- UI rendering (deterministic SSR) ----

const viewProps = (overrides: Record<string, unknown> = {}) => ({
  config: disabledDefault,
  models: [modelA, modelB],
  isLoading: false,
  isSaving: false,
  saveStatus: null,
  loadError: null,
  saveBlock: canSaveConfig(disabledDefault, [modelA, modelB]),
  pendingConfirm: false,
  onEnabledToggle: () => undefined,
  onConfirmEnable: () => undefined,
  onCancelEnable: () => undefined,
  onFieldChange: () => undefined,
  onModelChange: () => undefined,
  onApiKeyChange: () => undefined,
  onSave: () => undefined,
  onRetry: () => undefined,
  ...overrides,
});

test('UI: default-off renders with enable switch off and tool-images switch off', () => {
  const html = renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <VisionBridgeSettingsView {...(viewProps() as any)} />,
  );
  assert.ok(html.includes('data-testid="vb-enable-switch"'));
  assert.ok(html.includes('aria-checked="false"'));
  assert.ok(html.includes('data-testid="vb-toolimages-switch"'));
  // No confirm dialog while not enabling.
  assert.ok(!html.includes('data-testid="vb-confirm"'));
});

test('UI: model options, API format, endpoint and masked key are rendered', () => {
  const html = renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <VisionBridgeSettingsView {...(viewProps() as any)} />,
  );
  assert.ok(html.includes('gpt-4o-mini'));
  assert.ok(html.includes('claude-3.5-vision'));
  // New fields render: API format select, endpoint input, masked key input.
  assert.ok(html.includes('data-testid="vb-api-format"'));
  assert.ok(html.includes('data-testid="vb-base-url"'));
  assert.ok(html.includes('data-testid="vb-api-key"'));
  assert.ok(html.includes('type="password"'));
  // The key value is never rendered as a plaintext value.
  assert.ok(!html.includes('name="apiKey"'));
});

test('UI: enabling shows the outbound confirmation with provider, model and tool-image policy', () => {
  const cfg = enabledConfig();
  const html = renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <VisionBridgeSettingsView {...(viewProps({ config: cfg, pendingConfirm: true }) as any)} />,
  );
  assert.ok(html.includes('data-testid="vb-confirm"'));
  assert.ok(html.includes('openai'));
  assert.ok(html.includes('gpt-4o-mini'));
  // Tool images default off — policy text must reflect that.
  assert.ok(html.includes('data-testid="vb-confirm-toolimages-off"'));
});

test('UI: save is blocked and reason shown when the model has no credentials', () => {
  const cfg = enabledConfig({
    visionModel: { provider: 'anthropic', id: 'claude-3.5-vision' },
  });
  const html = renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <VisionBridgeSettingsView
      {...(viewProps({
        config: cfg,
        saveBlock: canSaveConfig(cfg, [modelA, modelB]),
      }) as any)}
    />,
  );
  assert.ok(html.includes('data-testid="vb-save"'));
  assert.ok(html.includes('disabled'));
  assert.ok(html.includes('data-testid="vb-save-blocked"'));
});
