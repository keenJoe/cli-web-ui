import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProviderUsage } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  requireUsageFacet: (provider: string) => IProviderUsage;
};

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  requireUsageFacet: (provider) => providerRegistry.requireFacet(provider, 'usage'),
};

/**
 * Creates the provider token-usage service used by routes and isolated tests.
 * The service owns app-session lookup only; provider storage and parsing remain
 * behind each registered usage facet.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    /** Resolves one app session and dispatches to its provider-owned usage facet. */
    async getSessionTokenUsage(
      sessionId: string,
    ): ReturnType<IProviderUsage['getSessionTokenUsage']> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const usage = dependencies.requireUsageFacet(session.provider);
      return usage.getSessionTokenUsage({
        sessionId,
        providerSessionId: session.provider_session_id || sessionId,
        projectPath: session.project_path ?? null,
        jsonlPath: session.jsonl_path ?? null,
      });
    },
  };
}

/** Used by provider routes to resolve token usage from an app session id. */
export const providerTokenUsageService = createProviderTokenUsageService();
