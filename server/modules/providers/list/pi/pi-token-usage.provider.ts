/**
 * PiTokenUsageProvider - derives a session's token usage from the last valid
 * assistant usage on the active branch, as computed by {@link PiSessionStore}.
 *
 * Pi does not fall back to another provider's default usage: when the session
 * snapshot carries no qualifying usage, `getTokenUsage` returns `null`.
 */
import type { IProviderUsage } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

import { PiSessionStore } from './pi-session-store.provider.js';

/** Token usage shape returned to the central token-usage service. */
type PiTokenUsage = {
  used: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  breakdown: {
    input: number;
    output: number;
  };
};

type SessionLoader = (filePath: string) => { lastUsage: import('./pi-session-store.provider.js').PiUsage | null };

/** ProviderRegistry mounts this facet on PiProvider for token-usage reads. */
export class PiTokenUsageProvider implements IProviderUsage {
  private readonly load: SessionLoader;

  constructor(deps: { load?: SessionLoader } = {}) {
    this.load = deps.load ?? ((filePath) => PiSessionStore.load(filePath));
  }

  /**
   * Returns the token usage for a Pi session file, or `null` when the snapshot
   * has no last valid usage.
   */
  getTokenUsage(sessionFilePath: string): PiTokenUsage | null {
    const snapshot = this.load(sessionFilePath);
    const usage = snapshot.lastUsage;
    if (!usage) {
      return null;
    }

    return {
      used: usage.totalTokens,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheWrite,
      cacheTokens: usage.cacheRead + usage.cacheWrite,
      breakdown: {
        input: usage.input,
        output: usage.output,
      },
    };
  }

  async getSessionTokenUsage(
    session: Parameters<IProviderUsage['getSessionTokenUsage']>[0],
  ): ReturnType<IProviderUsage['getSessionTokenUsage']> {
    if (!session.jsonlPath) {
      throw new AppError(`Pi session file for "${session.sessionId}" was not found.`, {
        code: 'SESSION_FILE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const usage = this.getTokenUsage(session.jsonlPath);
    return usage ?? {
      used: 0,
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
      message: 'No token usage recorded for this Pi session',
    };
  }
}
