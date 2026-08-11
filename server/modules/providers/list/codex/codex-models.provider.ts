import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels, ProviderModelsCatalog } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  computeModelsFingerprint,
  fetchOpenAICompatModels,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { CodexConfig } from './codex-config.js';

/**
 * Synchronous mirror of `CodexConfig.load()` credential resolution, reduced to
 * the credential value the fingerprint hashes. Keeps the pre-fetch fingerprint
 * aligned with what `getSupportedModels` returns without pulling the catalog.
 */
const readCodexCredentialValue = (provider: Record<string, any>): string | undefined => {
  const bearerToken = readOptionalString(provider.experimental_bearer_token);
  if (bearerToken) {
    return bearerToken;
  }

  const apiKey = readOptionalString(provider.api_key);
  if (apiKey) {
    return apiKey;
  }

  const envKey = readOptionalString(provider.env_key);
  if (envKey) {
    return readOptionalString(process.env[envKey]);
  }

  return undefined;
};

/**
 * Computes the codex catalog fingerprint from `config.toml` only, without
 * loading models. Config read failures mirror `CodexConfig.load()`: missing or
 * malformed config yields an empty fingerprint.
 */
const computeCodexCatalogFingerprint = (configPath: string): string => {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return '';
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch {
    return '';
  }

  const config = readObjectRecord(parsed);
  if (!config) {
    return '';
  }

  const model = readOptionalString(config.model);
  const modelProvider = readOptionalString(config.model_provider);
  const providers = readObjectRecord(config.model_providers);
  const activeProvider = modelProvider ? readObjectRecord(providers?.[modelProvider]) : null;

  return computeModelsFingerprint({
    baseUrl: activeProvider ? readOptionalString(activeProvider.base_url) : undefined,
    credential: activeProvider ? readCodexCredentialValue(activeProvider) : undefined,
    modelProvider,
    model,
  });
};

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'gpt-5.4',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'gpt-5.4-mini',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.4',
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
};

const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => {
  const effortValues = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
      .map((level) => {
        const value = readOptionalString(level?.effort);
        if (!value) {
          return null;
        }

        return {
          value,
          description: readOptionalString(level?.description),
        };
      })
      .filter((level): level is NonNullable<typeof level> => Boolean(level))
    : [];

  return {
    value: model.slug as string,
    label: readOptionalString(model.display_name) ?? (model.slug as string),
    description: readOptionalString(model.description),
    effort: effortValues.length > 0
      ? {
          default: readOptionalString(model.default_reasoning_level) ?? undefined,
          values: effortValues,
        }
      : undefined,
  };
};

const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  const sortedModels = [...models]
    .filter((model) => model.visibility === 'list' && model.supported_in_api !== false)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  return {
    OPTIONS: options,
    DEFAULT: options[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT,
  };
};

// The gateway `/v1/models` payload only carries `{value, label}` and drops the
// reasoning-effort metadata `models_cache.json` supplies. Re-attach the levels
// the Codex SDK accepts (`ModelReasoningEffort`) so the composer's Reasoning
// selector keeps working for config-driven catalogs.
const CODEX_FETCHED_EFFORT: NonNullable<ProviderModelOption['effort']> = {
  default: 'medium',
  values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
};

const buildCodexModelsDefinitionFromFetched = (
  fetched: Array<{ value: string; label: string }>,
): ProviderModelsDefinition => {
  if (fetched.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  return {
    OPTIONS: fetched.map((option) => ({ ...option, effort: CODEX_FETCHED_EFFORT })),
    DEFAULT: fetched[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT,
  };
};

type CodexProviderModelsDependencies = {
  configPath?: string;
  modelsCachePath?: string;
};

export class CodexProviderModels implements IProviderModels {
  readonly usesCatalogDefaultWhenModelOmitted = true as const;

  private readonly config: CodexConfig;
  private readonly modelsCachePath: string;
  private readonly configPath: string;

  constructor(dependencies: CodexProviderModelsDependencies = {}) {
    this.config = new CodexConfig(dependencies.configPath);
    this.modelsCachePath = dependencies.modelsCachePath ?? CODEX_MODELS_CACHE_PATH;
    this.configPath = dependencies.configPath ?? CODEX_CONFIG_PATH;
  }

  getCachedCatalogFingerprint(): string {
    return computeCodexCatalogFingerprint(this.configPath);
  }

  async getSupportedModels(): Promise<ProviderModelsCatalog> {
    const config = await this.config.load();
    const fingerprint = config
      ? computeModelsFingerprint({
          baseUrl: config.baseUrl,
          credential: config.credential?.value,
          modelProvider: config.modelProvider,
          model: config.model,
        })
      : '';

    if (config?.baseUrl && config.credential) {
      const fetched = await fetchOpenAICompatModels(config.baseUrl, config.credential.value);
      if (fetched) {
        return {
          models: buildCodexModelsDefinitionFromFetched(fetched),
          fingerprint,
          cacheable: true,
        };
      }

      // The configured API failed: fall back to the existing sources while
      // keeping the full fingerprint so a different configuration never shares
      // this entry, and stay out of the long-lived disk cache.
      return {
        models: await this.loadFallbackModels(),
        fingerprint,
        cacheable: false,
      };
    }

    return {
      models: await this.loadFallbackModels(),
      fingerprint,
      cacheable: fingerprint === '',
    };
  }

  private async loadFallbackModels(): Promise<ProviderModelsDefinition> {
    try {
      const raw = await readFile(this.modelsCachePath, 'utf8');
      const parsed = readObjectRecord(JSON.parse(raw));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];

      return buildCodexModelsDefinition(models);
    } catch {
      return CODEX_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel((await this.getSupportedModels()).models);
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel((await this.getSupportedModels()).models);
    }
  }
}
