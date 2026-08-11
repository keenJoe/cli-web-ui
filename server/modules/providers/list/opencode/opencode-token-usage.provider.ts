import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import type { IProviderUsage } from '@/shared/interfaces.js';
import {
  AppError,
  getOpenCodeDatabasePath,
  readFiniteUsageNumber,
} from '@/shared/utils.js';

type UsageSession = Parameters<IProviderUsage['getSessionTokenUsage']>[0];
type UsageResult = Awaited<ReturnType<IProviderUsage['getSessionTokenUsage']>>;

type OpenCodeTokenUsageDependencies = {
  getDatabasePath: () => string;
  fileExists: (filePath: string) => boolean;
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

const defaultDependencies: OpenCodeTokenUsageDependencies = {
  getDatabasePath: getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
};

/** ProviderRegistry mounts this facet on OpenCodeProvider for token-usage reads. */
export class OpenCodeTokenUsageProvider implements IProviderUsage {
  private readonly dependencies: OpenCodeTokenUsageDependencies;

  constructor(overrides: Partial<OpenCodeTokenUsageDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...overrides };
  }

  async getSessionTokenUsage(session: UsageSession): Promise<UsageResult> {
    const databasePath = this.dependencies.getDatabasePath();
    if (!this.dependencies.fileExists(databasePath)) {
      throw new AppError('OpenCode database was not found.', {
        code: 'OPENCODE_DATABASE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map((column) => column.name));
      const requiredColumns = [
        'tokens_input',
        'tokens_output',
        'tokens_reasoning',
        'tokens_cache_read',
        'tokens_cache_write',
      ];
      if (!requiredColumns.every((column) => columnNames.has(column))) {
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking is not available in this OpenCode database schema',
        };
      }

      const row = database.prepare(`
        SELECT
          tokens_input AS inputTokens,
          tokens_output AS outputTokens,
          tokens_reasoning AS reasoningTokens,
          tokens_cache_read AS cacheReadTokens,
          tokens_cache_write AS cacheWriteTokens
        FROM session
        WHERE id = ?
      `).get(session.providerSessionId) as OpenCodeTokenRow | undefined;
      if (!row) {
        throw new AppError('OpenCode session was not found.', {
          code: 'OPENCODE_SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const inputTokens = readFiniteUsageNumber(row.inputTokens)
        + readFiniteUsageNumber(row.cacheReadTokens);
      const outputTokens = readFiniteUsageNumber(row.outputTokens);
      const used = readFiniteUsageNumber(row.inputTokens)
        + outputTokens
        + readFiniteUsageNumber(row.reasoningTokens)
        + readFiniteUsageNumber(row.cacheReadTokens)
        + readFiniteUsageNumber(row.cacheWriteTokens);
      return {
        used,
        inputTokens,
        outputTokens,
        breakdown: { input: inputTokens, output: outputTokens },
      };
    } finally {
      database.close();
    }
  }
}
