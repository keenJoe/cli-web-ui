/**
 * PiVisionModelCatalogProvider — read-only adapter for the vision-bridge model
 * catalog (the Pi-owned side of the model-catalog port).
 *
 * The official `RpcClient.getAvailableModels()` narrows the runtime response to
 * `ModelInfo` (provider/id/contextWindow/reasoning) at the type level, but the
 * runtime object really is the full `Model<any>[]`. This adapter therefore
 * performs a local structured decode over the raw runtime value and reduces
 * each image-capable model to a credential-free option. It never returns
 * apiKey, headers, endpoints, or baseUrl.
 *
 * Probe failures return a structured `{ available:false }` result instead of
 * throwing, so the vision-bridge config service maps that to a retryable
 * `ERR-VB-MODELS-UNAVAILABLE` error.
 */
import type { VisionBridgeModelCatalogPort, VisionBridgeModelCatalogResult } from '@/shared/types.js';

import type { VisionBridgeModelOptionV1 } from '../../../../../shared/vision-bridge.js';

import { PiRpcClient } from './pi-rpc-client.provider.js';

/** Loose runtime shape of one Pi `Model<any>` entry (avoids importing the nested `@earendil-works/pi-ai` package). */
type PiModelShape = {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  api?: unknown;
  input?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
};

/**
 * Structured decoder for the full Pi model snapshot.
 *
 * The official client types this as `ModelInfo[]`, but the runtime object
 * carries the complete `Model<any>[]`. This decoder is defensive and only
 * reduces models that actually declare an `input` array containing `"image"`;
 * models without an `input` field never enter the catalog.
 */
export function decodePiModelSnapshot(raw: unknown): VisionBridgeModelOptionV1[] {
  const models = Array.isArray(raw) ? raw : (raw as { models?: unknown } | null | undefined)?.models;
  if (!Array.isArray(models)) {
    return [];
  }

  const options: VisionBridgeModelOptionV1[] = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const model = entry as PiModelShape;
    const input = model.input;
    const supportsImage = Array.isArray(input) && input.includes('image');
    if (!supportsImage) {
      continue;
    }
    if (typeof model.provider !== 'string' || typeof model.id !== 'string') {
      continue;
    }
    if (!model.provider || !model.id) {
      continue;
    }

    options.push({
      provider: model.provider,
      id: model.id,
      ...(typeof model.name === 'string' ? { displayName: model.name } : {}),
      ...(typeof model.api === 'string' ? { apiKind: model.api } : {}),
      credentialAvailable: true,
      supportsImage,
      ...(typeof model.contextWindow === 'number'
        ? { contextWindow: model.contextWindow }
        : {}),
      ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
      reasoning: model.reasoning === true,
    });
  }

  return options;
}

/** Raw model snapshot reader used by {@link createPiVisionModelCatalogProvider}. */
export type PiVisionModelProbe = () => Promise<unknown>;

/**
 * TTL for the in-process catalog cache. The model list changes only when
 * Pi's `models.json`/auth catalog is edited (rare), and every cache miss
 * spawns a fresh `pi --mode rpc` child (~1-3s); caching eliminates a per-tab
 * switch downstream probe on the settings page.
 */
const CATALOG_CACHE_TTL_MS = 60_000;

/**
 * Creates the Pi vision-model catalog port.
 *
 * `probe` reads the raw available-models response (`Model<any>[]` or the
 * `{ models }` wrapper). Production passes a `PiRpcClient.getAvailableModels()`
 * call cast through `unknown`; tests inject a fixed array. A throwing or empty
 * probe yields `{ available:false }`. Successful decodes are cached in-process
 * for {@link CATALOG_CACHE_TTL_MS} so the settings page never re-spawns the Pi
 * child on every mount; failures are not cached (retry on next call).
 */
export function createPiVisionModelCatalogProvider(
  probe: PiVisionModelProbe,
): VisionBridgeModelCatalogPort {
  let cachedAt = 0;
  let cachedModels: VisionBridgeModelOptionV1[] | null = null;

  return {
    async listVisionModels(): Promise<VisionBridgeModelCatalogResult> {
      if (cachedModels !== null && Date.now() - cachedAt < CATALOG_CACHE_TTL_MS) {
        return { available: true, models: cachedModels };
      }

      let raw: unknown;
      try {
        raw = await probe();
      } catch {
        return { available: false, models: [] };
      }
      const models = decodePiModelSnapshot(raw);
      if (models.length === 0) {
        return { available: false, models: [] };
      }
      cachedModels = models;
      cachedAt = Date.now();
      return { available: true, models };
    },
  };
}

/** Probe grace window for the clean catalog probe, matching the models probe. */
const CATALOG_PROBE_GRACE_MS = 5000;

/**
 * Default production probe: spawns a clean `PiRpcClient` (no vision-bridge
 * extension), reads the raw available-models snapshot, and closes the client.
 *
 * The official `getAvailableModels(): Promise<ModelInfo[]>` narrows the type
 * only — at runtime it returns the full `Model<any>[]` — so the value is cast
 * through `unknown` into the structured decoder. Any failure yields an empty
 * array, which `listVisionModels` maps to `{ available:false }`.
 */
export async function probePiVisionModelsRaw(): Promise<unknown> {
  const client = new PiRpcClient();
  try {
    await client.start();
    // SAFETY: runtime value carries the full Model<any>[] even though the
    // wrapper types it as ModelInfo[]; decodePiModelSnapshot only reads the
    // fields that exist on the runtime objects.
    return (await client.getAvailableModels()) as unknown;
  } finally {
    try {
      await client.close(CATALOG_PROBE_GRACE_MS);
    } catch {
      // Teardown failures are irrelevant to the catalog result.
    }
  }
}