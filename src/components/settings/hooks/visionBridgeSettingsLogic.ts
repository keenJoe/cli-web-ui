/**
 * Pure, framework-free vision-bridge settings logic.
 *
 * This module depends ONLY on the shared `vision-bridge` contract — never on
 * React, `fetch`, or Vite's `import.meta.env` — so it can be imported directly
 * by unit tests under plain `node --import tsx --test`.
 *
 * Security invariant: every parser here constructs a BRAND-NEW object picking
 * ONLY the known public fields. Even if a future backend bug leaks
 * `apiKey`/`baseUrl`/`userId`/`configPath`/`headers`/`endpoint` into a
 * response, those fields can never enter form state or logs.
 */

import {
  VISION_BRIDGE_API_KEY_KEEP,
  VISION_BRIDGE_API_FORMATS,
  VISION_BRIDGE_DEFAULT_PROMPT_TEMPLATE,
  VISION_BRIDGE_DEFAULTS,
  VISION_BRIDGE_SCHEMA_VERSION,
  normalizePromptTemplate,
} from '../../../../shared/vision-bridge.js';
import type {
  VisionBridgeApiFormat,
  VisionBridgeModelOptionV1,
  VisionBridgeModelRef,
  VisionBridgePublicConfigV1,
  VisionBridgeUpdateInputV1,
} from '../../../../shared/vision-bridge.js';

//----------------- DESENSITIZATION ------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickModelRef(value: unknown): VisionBridgeModelRef | undefined {
  // Only read the known fields; any extra keys (e.g. a leaked secret) are
  // ignored and never copied into the fresh object we return.
  if (!isObject(value)) {
    return undefined;
  }
  if (typeof value.provider !== 'string' || typeof value.id !== 'string') {
    return undefined;
  }
  return { provider: value.provider, id: value.id };
}

function pickSources(value: unknown): VisionBridgePublicConfigV1['sources'] | undefined {
  // Ignore unknown nested keys; only the two booleans are copied.
  if (!isObject(value)) {
    return undefined;
  }
  if (typeof value.userImages !== 'boolean' || typeof value.toolImages !== 'boolean') {
    return undefined;
  }
  return { userImages: value.userImages, toolImages: value.toolImages };
}

function pickAvailability(
  value: unknown,
): VisionBridgePublicConfigV1['visionModelAvailability'] {
  // Ignore unknown nested keys; only the two booleans are copied.
  if (!isObject(value)) {
    return undefined;
  }
  if (
    typeof value.available !== 'boolean' ||
    typeof value.credentialAvailable !== 'boolean'
  ) {
    return undefined;
  }
  return { available: value.available, credentialAvailable: value.credentialAvailable };
}

/**
 * Strict-whitelist picker for a public config. Constructs a BRAND-NEW object
 * from ONLY the known public fields; any unknown key (e.g. `apiKey`,
 * `baseUrl`, `userId`, `configPath`, `headers`, `endpoint`) is SILENTLY
 * DROPPED and can never reach form state or logs. Returns `null` only when a
 * known field is missing or has the wrong type (a genuinely corrupt config).
 */
export function pickPublicConfig(input: unknown): VisionBridgePublicConfigV1 | null {
  if (!isObject(input)) {
    return null;
  }
  if (input.schemaVersion !== VISION_BRIDGE_SCHEMA_VERSION) {
    return null;
  }
  if (typeof input.enabled !== 'boolean') {
    return null;
  }

  let visionModel: VisionBridgeModelRef | undefined;
  if (input.visionModel !== undefined) {
    const picked = pickModelRef(input.visionModel);
    if (!picked) {
      return null;
    }
    visionModel = picked;
  }

  // apiFormat is required, defaults to 'auto' when omitted (older configs).
  let apiFormat: VisionBridgeApiFormat;
  if (input.apiFormat === undefined) {
    apiFormat = 'auto';
  } else if (
    typeof input.apiFormat !== 'string' ||
    !VISION_BRIDGE_API_FORMATS.includes(input.apiFormat as VisionBridgeApiFormat)
  ) {
    return null;
  } else {
    apiFormat = input.apiFormat as VisionBridgeApiFormat;
  }

  let baseUrl: string | undefined;
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== 'string') {
      return null;
    }
    if (input.baseUrl.trim() !== '') {
      baseUrl = input.baseUrl;
    }
  }

  const hasApiKey = input.hasApiKey === true;

  const maxImagesPerRun = input.maxImagesPerRun;
  if (typeof maxImagesPerRun !== 'number' || !Number.isInteger(maxImagesPerRun)) {
    return null;
  }
  const timeoutMs = input.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) {
    return null;
  }
  const concurrency = input.concurrency;
  if (typeof concurrency !== 'number' || !Number.isInteger(concurrency)) {
    return null;
  }
  const maxTokens = input.maxTokens;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens)) {
    return null;
  }
  if (typeof input.promptTemplate !== 'string') {
    return null;
  }

  const sources = pickSources(input.sources);
  if (!sources) {
    return null;
  }

  const availability = input.visionModelAvailability !== undefined
    ? pickAvailability(input.visionModelAvailability)
    : undefined;

  return {
    schemaVersion: 1,
    enabled: input.enabled,
    ...(visionModel ? { visionModel } : {}),
    apiFormat,
    ...(baseUrl ? { baseUrl } : {}),
    hasApiKey,
    maxImagesPerRun,
    timeoutMs,
    concurrency,
    maxTokens,
    promptTemplate: input.promptTemplate,
    sources,
    ...(availability ? { visionModelAvailability: availability } : {}),
  };
}

/**
 * Picks a model option from a raw catalog entry, keeping ONLY the safe
 * fields. Any `apiKey`/`headers`/`endpoint` a buggy backend might attach is
 * silently dropped rather than copied into state.
 */
export function pickModelOption(input: unknown): VisionBridgeModelOptionV1 | null {
  if (!isObject(input)) {
    return null;
  }
  if (typeof input.provider !== 'string' || typeof input.id !== 'string') {
    return null;
  }
  if (typeof input.credentialAvailable !== 'boolean') {
    return null;
  }
  if (typeof input.supportsImage !== 'boolean') {
    return null;
  }
  if (typeof input.reasoning !== 'boolean') {
    return null;
  }
  const option: VisionBridgeModelOptionV1 = {
    provider: input.provider,
    id: input.id,
    credentialAvailable: input.credentialAvailable,
    supportsImage: input.supportsImage,
    reasoning: input.reasoning,
  };
  if (typeof input.displayName === 'string') {
    option.displayName = input.displayName;
  }
  if (typeof input.description === 'string') {
    option.description = input.description;
  }
  if (typeof input.apiKind === 'string') {
    option.apiKind = input.apiKind;
  }
  if (typeof input.contextWindow === 'number') {
    option.contextWindow = input.contextWindow;
  }
  if (typeof input.maxTokens === 'number') {
    option.maxTokens = input.maxTokens;
  }
  return option;
}

//----------------- ENVELOPE PARSERS ------------

export type VisionBridgeSettingsError = { code?: number; message?: string };
export type EnvelopeError = { ok: false; errorCode?: number; message?: string };
export type ConfigEnvelopeResult =
  | ({ ok: true } & { config: VisionBridgePublicConfigV1 })
  | EnvelopeError;
export type ModelsEnvelopeResult =
  | ({ ok: true } & { models: VisionBridgeModelOptionV1[] })
  | EnvelopeError;

/**
 * Parses the `{ success, data?, error? }` envelope returned by
 * `GET /api/vision-bridge/config`. On success returns the desensitized
 * `pickPublicConfig(data)`; never the raw response.
 */
export function parseConfigEnvelope(raw: unknown): ConfigEnvelopeResult {
  if (!isObject(raw)) {
    return { ok: false };
  }
  if (raw.success === true) {
    const picked = pickPublicConfig(raw.data);
    if (!picked) {
      return { ok: false, errorCode: 4001 };
    }
    return { ok: true, config: picked };
  }
  const error = isObject(raw.error) ? raw.error : undefined;
  return {
    ok: false,
    errorCode: typeof error?.code === 'number' ? error.code : undefined,
    message: typeof error?.message === 'string' ? error.message : undefined,
  };
}

/**
 * Parses the `{ success, data?, error? }` envelope returned by
 * `GET /api/vision-bridge/models`. Each entry is desensitized via
 * `pickModelOption`; entries carrying unknown keys are rejected wholesale.
 */
export function parseModelsEnvelope(raw: unknown): ModelsEnvelopeResult {
  if (!isObject(raw)) {
    return { ok: false };
  }
  if (raw.success === true) {
    if (!Array.isArray(raw.data)) {
      return { ok: false, errorCode: 5031 };
    }
    const models: VisionBridgeModelOptionV1[] = [];
    for (const entry of raw.data) {
      const picked = pickModelOption(entry);
      if (!picked) {
        return { ok: false, errorCode: 5031 };
      }
      models.push(picked);
    }
    return { ok: true, models };
  }
  const error = isObject(raw.error) ? raw.error : undefined;
  return {
    ok: false,
    errorCode: typeof error?.code === 'number' ? error.code : undefined,
    message: typeof error?.message === 'string' ? error.message : undefined,
  };
}

//----------------- SAVE GUARDS ------------

export type SaveBlock =
  | { ok: true }
  | { ok: false; reasonKey: 'blockedNoModel' | 'blockedModelMissing' | 'blockedCredential' };

/**
 * Whether the current config may be saved. Disabling is always allowed.
 * Enabling requires a model: a catalog model with `credentialAvailable`, or a
 * custom-gateway model (baseUrl set) which is accepted as-is.
 */
export function canSaveConfig(
  config: VisionBridgePublicConfigV1 | null,
  models: VisionBridgeModelOptionV1[],
): SaveBlock {
  if (!config) {
    return { ok: false, reasonKey: 'blockedNoModel' };
  }
  if (!config.enabled) {
    return { ok: true };
  }
  if (!config.visionModel) {
    return { ok: false, reasonKey: 'blockedNoModel' };
  }
  const isCustomGateway = typeof config.baseUrl === 'string' && config.baseUrl.trim() !== '';
  if (isCustomGateway) {
    return { ok: true };
  }
  const found = models.find(
    (model) =>
      model.provider === config.visionModel!.provider &&
      model.id === config.visionModel!.id,
  );
  if (!found) {
    return { ok: false, reasonKey: 'blockedModelMissing' };
  }
  if (!found.credentialAvailable) {
    return { ok: false, reasonKey: 'blockedCredential' };
  }
  return { ok: true };
}

/**
 * Pure reducer for a save result. On failure the OLD config is preserved by
 * reference (no half-written new state enters the form). On success the
 * freshly picked (desensitized) config replaces it.
 */
export function reduceSaveResult(
  prevConfig: VisionBridgePublicConfigV1 | null,
  envelope: unknown,
): VisionBridgePublicConfigV1 | null {
  const parsed = parseConfigEnvelope(envelope);
  if (parsed.ok) {
    return parsed.config;
  }
  return prevConfig;
}

/**
 * Builds the user-editable update payload from the current form config.
 * Drops `schemaVersion` and `visionModelAvailability` (server-computed).
 * `apiKey` is only included when the caller passes an explicit `nextApiKey`
 * (the form's current keystroke); otherwise the KEEP sentinel preserves any
 * previously stored key without the browser ever seeing it.
 */
export function buildUpdateInput(
  config: VisionBridgePublicConfigV1,
  nextApiKey?: string,
): VisionBridgeUpdateInputV1 {
  return {
    enabled: config.enabled,
    ...(config.visionModel ? { visionModel: config.visionModel } : {}),
    apiFormat: config.apiFormat,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    apiKey: nextApiKey !== undefined ? nextApiKey : VISION_BRIDGE_API_KEY_KEEP,
    maxImagesPerRun: config.maxImagesPerRun,
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
    maxTokens: config.maxTokens,
    promptTemplate: config.promptTemplate,
    sources: config.sources,
  };
}

/** The default public config a fresh user sees: disabled, tool images off. */
export function createDefaultPublicConfig(): VisionBridgePublicConfigV1 {
  return {
    schemaVersion: VISION_BRIDGE_SCHEMA_VERSION,
    enabled: false,
    apiFormat: VISION_BRIDGE_DEFAULTS.apiFormat,
    hasApiKey: false,
    maxImagesPerRun: VISION_BRIDGE_DEFAULTS.maxImagesPerRun,
    timeoutMs: VISION_BRIDGE_DEFAULTS.timeoutMs,
    concurrency: VISION_BRIDGE_DEFAULTS.concurrency,
    maxTokens: VISION_BRIDGE_DEFAULTS.maxTokens,
    promptTemplate: normalizePromptTemplate(VISION_BRIDGE_DEFAULT_PROMPT_TEMPLATE),
    sources: { ...VISION_BRIDGE_DEFAULTS.sources },
  };
}
