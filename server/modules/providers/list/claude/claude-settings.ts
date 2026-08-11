import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

export type ClaudeSettingsSnapshot = {
  baseUrl: string;
  apiKey?: string;
  authToken?: string;
  hasCredential: boolean;
};

export type ClaudeAuthHeader = {
  header: 'x-api-key' | 'Authorization';
  value: string;
};

/**
 * Strips trailing slashes and a trailing `/v1` from a Claude base_url, then
 * appends the Anthropic models endpoint. A base_url that already ends in
 * `/v1` never produces a duplicated `/v1/v1/models` segment.
 */
export const resolveClaudeModelEndpoint = (baseUrl: string): string => {
  const withoutTrailingSlash = baseUrl.trim().replace(/\/+$/, '');
  const root = withoutTrailingSlash.replace(/\/v1$/, '');
  return `${root}/v1/models`;
};

/**
 * Maps a settings credential to the request header bound to its field type:
 * `ANTHROPIC_API_KEY` → `x-api-key`, `ANTHROPIC_AUTH_TOKEN` →
 * `Authorization: Bearer`. The auth token wins when both are present.
 */
export const resolveClaudeAuthHeader = (
  apiKey?: string,
  authToken?: string,
): ClaudeAuthHeader => {
  if (authToken) {
    return { header: 'Authorization', value: `Bearer ${authToken}` };
  }

  return { header: 'x-api-key', value: apiKey ?? '' };
};

/**
 * Reads the `ANTHROPIC_*` env values from `~/.claude/settings.json`. Returns
 * `null` when the file is missing, unreadable, or malformed, and also when the
 * config is incomplete: a credential without a base_url (or a base_url without
 * a credential) is treated as missing config — base_url has no default, so we
 * never fall back to an official-address request (R13).
 */
export const readClaudeSettings = async (
  settingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
): Promise<ClaudeSettingsSnapshot | null> => {
  let content: string;
  try {
    content = await readFile(settingsPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const settings = readObjectRecord(parsed);
  const env = settings ? readObjectRecord(settings.env) : null;
  if (!env) {
    return null;
  }

  const baseUrl = readOptionalString(env.ANTHROPIC_BASE_URL);
  const apiKey = readOptionalString(env.ANTHROPIC_API_KEY);
  const authToken = readOptionalString(env.ANTHROPIC_AUTH_TOKEN);
  const hasCredential = Boolean(apiKey || authToken);

  if (!baseUrl || !hasCredential) {
    return null;
  }

  return { baseUrl, apiKey, authToken, hasCredential };
};
