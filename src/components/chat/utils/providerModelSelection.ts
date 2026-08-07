import type { ProviderModelsDefinition } from '../../../types/app';

export function resolveProviderModelSelection(
  definition: ProviderModelsDefinition,
  ...candidates: Array<string | null | undefined>
): string | null {
  const catalogValues = new Set(
    definition.OPTIONS
      .map((option) => option.value.trim())
      .filter(Boolean),
  );

  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    // Local per-provider selections are only valid when the current catalog
    // still advertises them. Backend-reported session/provider models are
    // resolved separately by the session state because they are authoritative
    // for that existing session, even when a refreshed catalog lags behind.
    if (normalized && catalogValues.has(normalized)) {
      return normalized;
    }
  }

  const defaultModel = definition.DEFAULT?.trim();
  return defaultModel && catalogValues.has(defaultModel)
    ? defaultModel
    : null;
}
