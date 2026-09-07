/**
 * VisionBridgeConfigService — per-user vision-bridge config orchestration.
 *
 * Exposes `getPublicConfig`, `saveConfig`, and `resolveLaunchPolicy`. It owns
 * config validation (via the shared normalizer), vision-model capability
 * checks (via the injected model-catalog port), and persistence (via the
 * injected repository). It never reads images, never calls a model, and never
 * imports Pi internals: the catalog is injected at assembly.
 */
import type {
  VisionBridgeLaunchPolicy,
  VisionBridgeModelCatalogPort,
  VisionBridgeModelCatalogResult,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  normalizeVisionBridgeStoredConfig,
  normalizePromptTemplate,
  VISION_BRIDGE_API_KEY_KEEP,
  VISION_BRIDGE_CONFIG_INVALID,
  VISION_BRIDGE_CONFIG_WRITE_FAILED,
  VISION_BRIDGE_DEFAULT_PROMPT_TEMPLATE,
  VISION_BRIDGE_DEFAULTS,
  VISION_BRIDGE_MODEL_NOT_VISION,
  VISION_BRIDGE_MODELS_UNAVAILABLE,
  VISION_BRIDGE_SCHEMA_VERSION,
  type VisionBridgePublicConfigV1,
  type VisionBridgeStoredConfigV1,
  type VisionBridgeUpdateInputV1,
} from '../../../shared/vision-bridge.js';

import type { VisionBridgeConfigRepository } from './vision-bridge-config.repository.js';

/** Dependencies assembled by the vision-bridge module. */
export type VisionBridgeConfigServiceDependencies = {
  repository: VisionBridgeConfigRepository;
  modelCatalog: VisionBridgeModelCatalogPort;
};
/** Stable error codes the service maps validation/persistence failures to. */
const ERR = {
  configInvalid: () =>
    new AppError('视觉桥配置无效，请检查模型和参数', {
      code: VISION_BRIDGE_CONFIG_INVALID,
      statusCode: 400,
    }),
  modelNotVision: () =>
    new AppError('所选模型未声明图片输入能力', {
      code: VISION_BRIDGE_MODEL_NOT_VISION,
      statusCode: 400,
    }),
  modelsUnavailable: () =>
    new AppError('暂时无法读取可用视觉模型，请稍后重试', {
      code: VISION_BRIDGE_MODELS_UNAVAILABLE,
      statusCode: 503,
    }),
  writeFailed: () =>
    new AppError('无法保存视觉桥配置，请稍后重试', {
      code: VISION_BRIDGE_CONFIG_WRITE_FAILED,
      statusCode: 500,
    }),
};

/** Synthesized default config returned on a user's first read. */
function buildDefaultConfig(): VisionBridgeStoredConfigV1 {
  return {
    schemaVersion: VISION_BRIDGE_SCHEMA_VERSION,
    enabled: false,
    apiFormat: VISION_BRIDGE_DEFAULTS.apiFormat,
    maxImagesPerRun: VISION_BRIDGE_DEFAULTS.maxImagesPerRun,
    timeoutMs: VISION_BRIDGE_DEFAULTS.timeoutMs,
    concurrency: VISION_BRIDGE_DEFAULTS.concurrency,
    maxTokens: VISION_BRIDGE_DEFAULTS.maxTokens,
    promptTemplate: normalizePromptTemplate(VISION_BRIDGE_DEFAULT_PROMPT_TEMPLATE),
    sources: { ...VISION_BRIDGE_DEFAULTS.sources },
  };
}

/** Projects a stored config into the non-secret public DTO with model availability. */
function toPublicConfig(
  stored: VisionBridgeStoredConfigV1,
  catalog: VisionBridgeModelCatalogResult | null,
): VisionBridgePublicConfigV1 {
  const { visionModel, apiKey, ...rest } = stored;
  const publicConfig: VisionBridgePublicConfigV1 = {
    ...rest,
    ...(visionModel ? { visionModel } : {}),
    // The key bytes never leave the backend; the browser only learns existence.
    hasApiKey: typeof apiKey === 'string' && apiKey !== '',
  };

  if (visionModel) {
    const option = catalog?.models.find(
      (model) => model.provider === visionModel.provider && model.id === visionModel.id,
    );
    publicConfig.visionModelAvailability = option
      ? { available: true, credentialAvailable: option.credentialAvailable }
      : { available: false, credentialAvailable: false };
  }

  return publicConfig;
}

const UPDATE_CONFIG_KEYS = new Set([
  'enabled',
  'visionModel',
  'apiFormat',
  'baseUrl',
  'apiKey',
  'maxImagesPerRun',
  'timeoutMs',
  'concurrency',
  'maxTokens',
  'promptTemplate',
  'sources',
]);

/**
 * Builds a full stored config from a user update, with a strict whitelist parse.
 * Returns `null` when the update is structurally invalid (unknown fields —
 * including a non-update `schemaVersion` —, range violations, or a missing
 * model when enabled).
 */
function buildStoredConfig(update: unknown): VisionBridgeStoredConfigV1 | null {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return null;
  }
  const record = update as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!UPDATE_CONFIG_KEYS.has(key)) {
      return null;
    }
  }
  const candidate = {
    // schemaVersion is fixed to 1 and never accepted from user input.
    ...record,
    schemaVersion: VISION_BRIDGE_SCHEMA_VERSION,
  };
  return normalizeVisionBridgeStoredConfig(candidate);
}

/** Creates the vision-bridge config service with injected ports. */
export function createVisionBridgeConfigService(
  deps: VisionBridgeConfigServiceDependencies,
) {
  const { repository, modelCatalog } = deps;

  return {
    /** Returns the user's non-secret public config, with computed model availability. */
    async getPublicConfig(userId: string | number): Promise<VisionBridgePublicConfigV1> {
      const stored = (await repository.read(userId)) ?? buildDefaultConfig();

      let catalog: VisionBridgeModelCatalogResult | null = null;
      if (stored.visionModel) {
        catalog = await modelCatalog.listVisionModels();
      }
      return toPublicConfig(stored, catalog);
    },

    /**
     * Validates and atomically persists a full config update. Throws
     * `ERR-VB-CONFIG-INVALID`/`ERR-VB-MODEL-NOT-VISION`/
     * `ERR-VB-MODELS-UNAVAILABLE`/`ERR-VB-CONFIG-WRITE` as appropriate.
     */
    async saveConfig(
      userId: string | number,
      update: VisionBridgeUpdateInputV1,
    ): Promise<VisionBridgePublicConfigV1> {
      const stored = buildStoredConfig(update);
      if (!stored) {
        throw ERR.configInvalid();
      }

      // Resolve the KEEP_EXISTING sentinel against the previously stored key
      // so the form can preserve a key it cannot see, without ever storing the
      // sentinel itself as a credential.
      if (update.apiKey === VISION_BRIDGE_API_KEY_KEEP) {
        const previous = await repository.read(userId);
        if (previous?.apiKey) {
          stored.apiKey = previous.apiKey;
        } else {
          delete stored.apiKey;
        }
      }

      // Catalog capability gate is only required for models resolved through
      // Pi's registry. A custom-gateway model (baseUrl set) is accepted as-is:
      // its endpoint/handshake is the user's explicit responsibility, and the
      // runtime registers it as a throwaway provider.
      const isCustomGateway = typeof stored.baseUrl === 'string' && stored.baseUrl.trim() !== '';
      if (stored.visionModel && !isCustomGateway) {
        const catalog = await modelCatalog.listVisionModels();
        if (!catalog.available) {
          throw ERR.modelsUnavailable();
        }
        const found = catalog.models.some(
          (model) =>
            model.provider === stored.visionModel?.provider &&
            model.id === stored.visionModel?.id,
        );
        if (!found) {
          throw ERR.modelNotVision();
        }
      }

      try {
        await repository.save(userId, stored);
      } catch {
        throw ERR.writeFailed();
      }

      // Re-read the persisted config so the public DTO is the authoritative,
      // normalized on-disk copy.
      const persisted = (await repository.read(userId)) ?? stored;
      let catalogAfterSave: VisionBridgeModelCatalogResult | null = null;
      if (persisted.visionModel) {
        catalogAfterSave = await modelCatalog.listVisionModels();
      }
      return toPublicConfig(persisted, catalogAfterSave);
    },

    /**
     * Resolves `{ enabled, configPath }` for a live run. A missing/corrupt
     * user id or config yields a non-fatal disabled policy with diagnostics;
     * this never throws into an ordinary turn.
     */
    async resolveLaunchPolicy(
      userId: string | number | null | undefined,
    ): Promise<VisionBridgeLaunchPolicy> {
      if (userId === null || userId === undefined) {
        return { enabled: false, configPath: null, keyPath: null, diagnostics: ['缺少用户身份'] };
      }

      const str = String(userId);
      if (str.trim() === '') {
        return { enabled: false, configPath: null, keyPath: null, diagnostics: ['缺少用户身份'] };
      }

      const status = await repository.readStatus(userId);
      if (status === 'corrupt') {
        return { enabled: false, configPath: null, keyPath: null, diagnostics: ['配置损坏，已回退为关闭'] };
      }

      const stored = await repository.read(userId);
      if (!stored) {
        // Not configured yet is not an error; it's the safe default.
        return { enabled: false, configPath: null, keyPath: null, diagnostics: [] };
      }
      if (!stored.enabled) {
        return { enabled: false, configPath: null, keyPath: null, diagnostics: [] };
      }
      return {
        enabled: true,
        configPath: repository.getConfigPath(userId),
        // The live child decrypts any stored apiKey with this machine-local key.
        keyPath: repository.getKeyPath(),
        diagnostics: [],
      };
    },

    /** Lists the desensitized image-capable models via the injected catalog port. */
    async listModels(): Promise<VisionBridgeModelCatalogResult> {
      const catalog = await modelCatalog.listVisionModels();
      if (!catalog.available) {
        throw ERR.modelsUnavailable();
      }
      return catalog;
    },
  };
}

/** Concrete service type returned by {@link createVisionBridgeConfigService}. */
export type VisionBridgeConfigService = ReturnType<typeof createVisionBridgeConfigService>;