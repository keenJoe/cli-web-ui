import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

export type CodexProviderCredential =
  | { kind: 'experimental_bearer_token'; value: string }
  | { kind: 'api_key'; value: string }
  | { kind: 'env_key'; envVar: string; value: string };

export type CodexConfigSnapshot = {
  model?: string;
  modelProvider?: string;
  baseUrl?: string;
  credential?: CodexProviderCredential;
};

/**
 * Strips trailing slashes and a trailing `/v1` from a Codex provider base_url,
 * then appends the OpenAI-compatible models endpoint. A base_url that already
 * ends in `/v1` never produces a duplicated `/v1/v1/models` segment.
 */
export const normalizeModelsEndpoint = (baseUrl: string): string | null => {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return null;
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  const root = withoutTrailingSlash.replace(/\/v1$/, '');
  return `${root}/v1/models`;
};

const readCredential = (provider: AnyRecord): CodexProviderCredential | undefined => {
  const bearerToken = readOptionalString(provider.experimental_bearer_token);
  if (bearerToken) {
    return { kind: 'experimental_bearer_token', value: bearerToken };
  }

  const apiKey = readOptionalString(provider.api_key);
  if (apiKey) {
    return { kind: 'api_key', value: apiKey };
  }

  const envKey = readOptionalString(provider.env_key);
  if (envKey) {
    const value = readOptionalString(process.env[envKey]);
    if (value) {
      return { kind: 'env_key', envVar: envKey, value };
    }
  }

  return undefined;
};

export class CodexConfig {
  private readonly configPath: string;

  constructor(configPath: string = path.join(os.homedir(), '.codex', 'config.toml')) {
    this.configPath = configPath;
  }

  /**
   * Reads and parses `~/.codex/config.toml`. Returns `null` when the file is
   * missing, unreadable, or contains invalid TOML; callers never see a throw.
   */
  async load(): Promise<CodexConfigSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = TOML.parse(raw);
    } catch {
      return null;
    }

    const config = readObjectRecord(parsed);
    if (!config) {
      return null;
    }

    const model = readOptionalString(config.model);
    const modelProvider = readOptionalString(config.model_provider);
    const providers = readObjectRecord(config.model_providers);
    const activeProvider = modelProvider
      ? readObjectRecord(providers?.[modelProvider])
      : null;

    return {
      model,
      modelProvider,
      baseUrl: activeProvider ? readOptionalString(activeProvider.base_url) : undefined,
      credential: activeProvider ? readCredential(activeProvider) : undefined,
    };
  }
}
