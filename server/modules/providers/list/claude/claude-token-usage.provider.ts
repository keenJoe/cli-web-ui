import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';
import type { IProviderUsage } from '@/shared/interfaces.js';
import { AppError, readFiniteUsageNumber } from '@/shared/utils.js';

type UsageSession = Parameters<IProviderUsage['getSessionTokenUsage']>[0];
type UsageResult = Awaited<ReturnType<IProviderUsage['getSessionTokenUsage']>>;

type ClaudeTokenUsageDependencies = {
  getHomeDirectory: () => string;
  fileExists: (filePath: string) => boolean;
  readTextFile: (filePath: string) => Promise<string>;
  getContextWindow: () => string | undefined;
};

const defaultDependencies: ClaudeTokenUsageDependencies = {
  getHomeDirectory: () => os.homedir(),
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  getContextWindow: () => process.env.CONTEXT_WINDOW,
};

/** ProviderRegistry mounts this facet on ClaudeProvider for token-usage reads. */
export class ClaudeTokenUsageProvider implements IProviderUsage {
  private readonly dependencies: ClaudeTokenUsageDependencies;

  constructor(overrides: Partial<ClaudeTokenUsageDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...overrides };
  }

  async getSessionTokenUsage(session: UsageSession): Promise<UsageResult> {
    let sessionFilePath = session.jsonlPath;
    if (!sessionFilePath) {
      if (!session.projectPath) {
        throw new AppError(`Session file for "${session.sessionId}" was not found.`, {
          code: 'SESSION_FILE_NOT_FOUND',
          statusCode: 404,
        });
      }

      const encodedProjectPath = session.projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
      const projectDirectory = path.join(
        this.dependencies.getHomeDirectory(),
        '.claude',
        'projects',
        encodedProjectPath,
      );
      sessionFilePath = path.join(projectDirectory, `${session.providerSessionId}.jsonl`);

      const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(sessionFilePath));
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new AppError('Resolved session path is invalid.', {
          code: 'INVALID_SESSION_PATH',
          statusCode: 400,
        });
      }
    }

    if (!this.dependencies.fileExists(sessionFilePath)) {
      throw new AppError(`Session file for "${session.sessionId}" was not found.`, {
        code: 'SESSION_FILE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const fileContent = await this.dependencies.readTextFile(sessionFilePath);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    const lines = fileContent.trim().split('\n');

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]) as AnyRecord;
        const usage = entry.type === 'assistant' ? entry.message?.usage : null;
        if (!usage) {
          continue;
        }

        const directInputTokens = readFiniteUsageNumber(usage.input_tokens ?? usage.inputTokens);
        cacheReadTokens = readFiniteUsageNumber(
          usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
        );
        cacheCreationTokens = readFiniteUsageNumber(
          usage.cache_creation_input_tokens
            ?? usage.cacheCreationInputTokens
            ?? usage.cacheCreationTokens,
        );
        inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
        outputTokens = readFiniteUsageNumber(usage.output_tokens ?? usage.outputTokens);
        break;
      } catch {
        // Ignore a partially written trailing JSONL row and continue backward.
      }
    }

    const parsedContextWindow = Number.parseInt(this.dependencies.getContextWindow() ?? '', 10);
    const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160_000;
    const cacheTokens = cacheReadTokens + cacheCreationTokens;
    return {
      used: inputTokens + outputTokens,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  }
}
