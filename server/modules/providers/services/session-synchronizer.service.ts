import { scanStateDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeFailure = {
  provider: LLMProvider;
  reason: string;
};

type SessionSynchronizeResult = {
  processedByProvider: Partial<Record<LLMProvider, number>>;
  failures: SessionSynchronizeFailure[];
};

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers, each against its own scan cursor.
   *
   * Every provider reads and advances only its own `provider_scan_state` row,
   * so a provider that fails leaves the others' cursors untouched and only
   * rescans its own backlog next round. A provider with no row yet has no
   * cursor to pass, which means a full scan for that provider alone.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    const scanBoundary = new Date();
    const processedByProvider: Partial<Record<LLMProvider, number>> = {};
    const failures: SessionSynchronizeFailure[] = [];

    // Each task reports its own outcome instead of rejecting, so a failure
    // keeps the provider id attached to its reason. A bare rejection loses it.
    const results = await Promise.all(
      providerRegistry.listProviders().map(async (provider) => {
        try {
          const lastScanAt = scanStateDb.getLastScannedAt(provider.id);
          const processed = await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined);
          scanStateDb.updateLastScannedAt(provider.id, scanBoundary);
          return { provider: provider.id, processed, reason: null };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { provider: provider.id, processed: null, reason };
        }
      })
    );

    for (const result of results) {
      if (result.reason === null) {
        processedByProvider[result.provider] = result.processed ?? 0;
        continue;
      }

      failures.push({ provider: result.provider, reason: result.reason });
    }

    if (failures.length > 0) {
      const failureSummary = failures
        .map((failure) => `${failure.provider} (${failure.reason})`)
        .join(', ');
      console.warn(
        `[Sessions] ${failures.length} provider sync(s) failed; only their own scan cursors stayed put: ${failureSummary}`,
      );
    }

    return {
      processedByProvider,
      failures,
    };
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
