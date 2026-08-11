import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderUsage } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { AppError, readFiniteUsageNumber } from '@/shared/utils.js';

type UsageSession = Parameters<IProviderUsage['getSessionTokenUsage']>[0];
type UsageResult = Awaited<ReturnType<IProviderUsage['getSessionTokenUsage']>>;

type CodexTokenUsageDependencies = {
  getHomeDirectory: () => string;
  fileExists: (filePath: string) => boolean;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
};

const defaultDependencies: CodexTokenUsageDependencies = {
  getHomeDirectory: () => os.homedir(),
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
};

/** ProviderRegistry mounts this facet on CodexProvider for token-usage reads. */
export class CodexTokenUsageProvider implements IProviderUsage {
  private readonly dependencies: CodexTokenUsageDependencies;

  constructor(overrides: Partial<CodexTokenUsageDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...overrides };
  }

  private async findSessionFile(directoryPath: string, providerSessionId: string): Promise<string | null> {
    let entries: Dirent[];
    try {
      entries = await this.dependencies.readDirectory(directoryPath);
    } catch {
      return null;
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        const nestedMatch = await this.findSessionFile(entryPath, providerSessionId);
        if (nestedMatch) {
          return nestedMatch;
        }
      } else if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
        return entryPath;
      }
    }

    return null;
  }

  async getSessionTokenUsage(session: UsageSession): Promise<UsageResult> {
    const indexedFilePath = session.jsonlPath && this.dependencies.fileExists(session.jsonlPath)
      ? session.jsonlPath
      : null;
    const sessionFilePath = indexedFilePath ?? await this.findSessionFile(
      path.join(this.dependencies.getHomeDirectory(), '.codex', 'sessions'),
      session.providerSessionId,
    );
    if (!sessionFilePath) {
      throw new AppError(`Codex session file for "${session.sessionId}" was not found.`, {
        code: 'CODEX_SESSION_FILE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const fileContent = await this.dependencies.readTextFile(sessionFilePath);
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let contextWindow = 200_000;
    const lines = fileContent.trim().split('\n');

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]) as AnyRecord;
        const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
          ? entry.payload.info
          : null;
        if (!tokenInfo) {
          continue;
        }

        if (tokenInfo.total_token_usage) {
          inputTokens = readFiniteUsageNumber(tokenInfo.total_token_usage.input_tokens);
          outputTokens = readFiniteUsageNumber(tokenInfo.total_token_usage.output_tokens);
          totalTokens = readFiniteUsageNumber(tokenInfo.total_token_usage.total_tokens)
            || inputTokens + outputTokens;
        }
        contextWindow = readFiniteUsageNumber(tokenInfo.model_context_window) || contextWindow;
        break;
      } catch {
        // Ignore a partially written trailing JSONL row and continue backward.
      }
    }

    return {
      used: totalTokens,
      total: contextWindow,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  }
}
