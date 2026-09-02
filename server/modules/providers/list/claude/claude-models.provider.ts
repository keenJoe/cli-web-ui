import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels, ProviderModelsCatalog } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  computeModelsFingerprint,
  fetchAnthropicModels,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { readClaudeSettings } from './claude-settings.js';

export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the Claude Code default model (currently Sonnet 5)',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable',
      description: 'Fable 5 · Most capable for your hardest and longest-running tasks · Uses your limits ~2× faster than Opus',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: "sonnet",
      label: "Sonnet",
      description: "Sonnet 5 · Best for everyday tasks · $3/$15 per Mtok",
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet 5 for long sessions · $3/$15 per Mtok',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Opus 4.8 · Best for everyday, complex tasks · ~2× usage vs Sonnet',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus 4.8 (1M context)',
      description: 'Opus 4.8 with 1M context · Most capable for complex work · $5/$25 per Mtok',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok',
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};

// The gateway `/v1/models` payload only carries `{value, label}` and drops the
// reasoning-effort metadata. Re-attach it by model family so the composer's
// Reasoning selector keeps working for config-driven catalogs.
const CLAUDE_EFFORT_BY_FAMILY: Record<string, ProviderModelOption['effort']> = {
  opus: {
    default: 'high',
    values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }],
  },
  fable: {
    default: 'high',
    values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }],
  },
  sonnet: {
    default: 'high',
    values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }],
  },
};

const resolveClaudeEffortForModel = (value: string): ProviderModelOption['effort'] | undefined => {
  const normalized = value.toLowerCase();
  // haiku has no reasoning effort; leave it undefined so the selector stays hidden.
  if (normalized.includes('haiku')) {
    return undefined;
  }
  for (const [family, effort] of Object.entries(CLAUDE_EFFORT_BY_FAMILY)) {
    if (normalized.includes(family)) {
      return effort;
    }
  }
  return undefined;
};

const buildClaudeModelsDefinitionFromFetched = (
  fetched: Array<{ value: string; label: string }>,
): ProviderModelsDefinition => {
  if (fetched.length === 0) {
    return CLAUDE_FALLBACK_MODELS;
  }

  return {
    OPTIONS: fetched.map((option) => {
      const effort = resolveClaudeEffortForModel(option.value);
      return effort ? { ...option, effort } : option;
    }),
    DEFAULT: fetched[0]?.value ?? CLAUDE_FALLBACK_MODELS.DEFAULT,
  };
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  private readonly settingsPath: string;

  constructor(dependencies: { settingsPath?: string } = {}) {
    this.settingsPath = dependencies.settingsPath
      ?? path.join(os.homedir(), '.claude', 'settings.json');
  }

  async getSupportedModels(): Promise<ProviderModelsCatalog> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    const settings = await readClaudeSettings(this.settingsPath);
    const fingerprint = settings
      ? computeModelsFingerprint({
          baseUrl: settings.baseUrl,
          credential: settings.authToken ?? settings.apiKey,
        })
      : '';

    if (settings) {
      const fetched = await fetchAnthropicModels(settings.baseUrl, settings.apiKey, settings.authToken);
      if (fetched) {
        return {
          models: buildClaudeModelsDefinitionFromFetched(fetched),
          fingerprint,
          cacheable: true,
        };
      }

      // The configured API failed: fall back to the built-in list while
      // keeping the full fingerprint so a different configuration never shares
      // this entry, and stay out of the long-lived disk cache.
      return {
        models: CLAUDE_FALLBACK_MODELS,
        fingerprint,
        cacheable: false,
      };
    }

    return {
      models: CLAUDE_FALLBACK_MODELS,
      fingerprint,
      cacheable: fingerprint === '',
    };
  }

  getCachedCatalogFingerprint(): string {
    // Synchronous mirror of `readClaudeSettings()`: settings missing or
    // incomplete (no base_url or no credential) yield an empty fingerprint.
    let content: string;
    try {
      content = readFileSync(this.settingsPath, 'utf8');
    } catch {
      return '';
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return '';
    }

    const settings = readObjectRecord(parsed);
    const env = settings ? readObjectRecord(settings.env) : null;
    if (!env) {
      return '';
    }

    const baseUrl = readOptionalString(env.ANTHROPIC_BASE_URL);
    const apiKey = readOptionalString(env.ANTHROPIC_API_KEY);
    const authToken = readOptionalString(env.ANTHROPIC_AUTH_TOKEN);
    if (!baseUrl || !(apiKey || authToken)) {
      return '';
    }

    return computeModelsFingerprint({
      baseUrl,
      credential: authToken ?? apiKey,
    });
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel((await this.getSupportedModels()).models);
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel((await this.getSupportedModels()).models);
  }
}
