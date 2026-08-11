import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const AUTH_STATUS_CACHE_TTL_MS = 10 * 1000;

type AuthStatusCacheEntry = {
  promise: Promise<ProviderAuthStatus>;
  expiresAt: number;
};

const authStatusCache = new Map<string, AuthStatusCacheEntry>();

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   *
   * The probe result is cached for ~10s so gate re-checks inside one flow (auth
   * assertion + models fetch) share a single probe; concurrent calls await the
   * same in-flight probe instead of starting a second one.
   */
  async getProviderAuthStatus(providerName: string): Promise<ProviderAuthStatus> {
    const now = Date.now();
    const cached = authStatusCache.get(providerName);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const promise = (async () => {
      const provider = providerRegistry.resolveProvider(providerName);
      return provider.auth.getStatus();
    })();

    authStatusCache.set(providerName, { promise, expiresAt: now + AUTH_STATUS_CACHE_TTL_MS });
    return promise;
  },

  /**
   * Guards model-catalog access behind the provider being both installed and
   * authenticated. The models service runs this on every catalog read and
   * active-model write, so REST routes and the built-in /models command share
   * one assertion and cannot bypass it.
   */
  async assertProviderAuthenticated(provider: LLMProvider): Promise<void> {
    const status = await this.getProviderAuthStatus(provider);
    if (!status.installed || !status.authenticated) {
      throw new AppError('provider 未安装或未认证', {
        code: 'PROVIDER_NOT_AUTHENTICATED',
        statusCode: 401,
      });
    }
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};
