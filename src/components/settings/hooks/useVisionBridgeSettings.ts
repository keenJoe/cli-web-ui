import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type {
  VisionBridgeModelOptionV1,
  VisionBridgePublicConfigV1,
} from '../../../../shared/vision-bridge.js';

import {
  buildUpdateInput,
  canSaveConfig,
  createDefaultPublicConfig,
  parseConfigEnvelope,
  parseModelsEnvelope,
  pickModelOption,
  pickPublicConfig,
  reduceSaveResult,
} from './visionBridgeSettingsLogic';
import type {
  SaveBlock,
  VisionBridgeSettingsError,
} from './visionBridgeSettingsLogic';

// Re-export the pure desensitization helpers and types so consumers can
// import everything from one place; the helpers themselves stay framework-
// free and live in `visionBridgeSettingsLogic.ts`.
export {
  buildUpdateInput,
  canSaveConfig,
  createDefaultPublicConfig,
  parseConfigEnvelope,
  parseModelsEnvelope,
  pickModelOption,
  pickPublicConfig,
  reduceSaveResult,
};
export type { SaveBlock, VisionBridgeSettingsError };

const toResponseJson = async <T>(response: Response): Promise<T> =>
  response.json() as Promise<T>;

export type UseVisionBridgeSettingsResult = {
  config: VisionBridgePublicConfigV1 | null;
  models: VisionBridgeModelOptionV1[];
  isLoading: boolean;
  isSaving: boolean;
  saveStatus: 'success' | 'error' | null;
  loadError: VisionBridgeSettingsError | null;
  pendingConfirm: boolean;
  saveBlock: SaveBlock;
  setField: <K extends keyof VisionBridgePublicConfigV1>(
    field: K,
    value: VisionBridgePublicConfigV1[K],
  ) => void;
  setModel: (provider: string, id: string) => void;
  /** Set the current apiKey keystroke; empty means "keep existing". */
  setApiKey: (value: string) => void;
  requestEnable: () => void;
  confirmEnable: () => void;
  cancelConfirm: () => void;
  save: () => Promise<void>;
  reload: () => Promise<void>;
};

/**
 * React hook backing the vision-bridge settings tab. Reads
 * `GET /api/vision-bridge/config` and `GET /api/vision-bridge/models`,
 * desensitizing every response through the pure pickers before it reaches
 * form state, and saves via `PUT /api/vision-bridge/config`. On save failure
 * the OLD config is preserved (see `reduceSaveResult`).
 *
 * `apiKey` is special: the backend never returns it (only `hasApiKey`), so the
 * hook holds the user's current keystroke in a separate ref and only forwards
 * it as `nextApiKey` on save. An empty field means "keep the stored key".
 */
export function useVisionBridgeSettings(): UseVisionBridgeSettingsResult {
  const [config, setConfig] = useState<VisionBridgePublicConfigV1 | null>(null);
  const [models, setModels] = useState<VisionBridgeModelOptionV1[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [loadError, setLoadError] = useState<VisionBridgeSettingsError | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  /** Current apiKey keystroke; empty = "keep existing" (KEEP sentinel on save). */
  const apiKeyRef = useRef<string>('');
  const saveStatusTimerRef = useRef<number | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [configResponse, modelsResponse] = await Promise.all([
        authenticatedFetch('/api/vision-bridge/config'),
        authenticatedFetch('/api/vision-bridge/models'),
      ]);
      const [configPayload, modelsPayload] = await Promise.all([
        toResponseJson<unknown>(configResponse),
        toResponseJson<unknown>(modelsResponse),
      ]);

      const configResult = parseConfigEnvelope(configPayload);
      if (configResult.ok) {
        setConfig(configResult.config);
      } else {
        // Fall back to a safe default disabled config so the form stays
        // usable even when the stored config is corrupt; surface the error.
        setConfig(createDefaultPublicConfig());
        setLoadError({ code: configResult.errorCode, message: configResult.message });
      }

      const modelsResult = parseModelsEnvelope(modelsPayload);
      if (modelsResult.ok) {
        setModels(modelsResult.models);
      } else {
        setModels([]);
        setLoadError({ code: modelsResult.errorCode, message: modelsResult.message });
      }
    } catch (error) {
      console.error('vision-bridge: failed to load settings', error);
      setConfig(createDefaultPublicConfig());
      setLoadError({ message: 'loadFailed' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () => () => {
      if (saveStatusTimerRef.current !== null) {
        window.clearTimeout(saveStatusTimerRef.current);
      }
    },
    [],
  );

  const setField = useCallback(
    <K extends keyof VisionBridgePublicConfigV1>(
      field: K,
      value: VisionBridgePublicConfigV1[K],
    ) => {
      setConfig((prev) => {
        if (!prev) {
          return prev;
        }
        return { ...prev, [field]: value };
      });
    },
    [],
  );

  const setModel = useCallback((provider: string, id: string) => {
    setConfig((prev) => {
      if (!prev) {
        return prev;
      }
      const availability = models.find(
        (model) => model.provider === provider && model.id === id,
      );
      return {
        ...prev,
        visionModel: { provider, id },
        visionModelAvailability: availability
          ? { available: true, credentialAvailable: availability.credentialAvailable }
          : { available: false, credentialAvailable: false },
      };
    });
  }, [models]);

  const requestEnable = useCallback(() => {
    // Only ask for confirmation when moving from disabled to enabled.
    setConfig((prev) => {
      if (prev?.enabled) {
        return prev;
      }
      setPendingConfirm(true);
      return prev;
    });
  }, []);

  const confirmEnable = useCallback(() => {
    setPendingConfirm(false);
    setConfig((prev) => (prev ? { ...prev, enabled: true } : prev));
  }, []);

  const cancelConfirm = useCallback(() => {
    setPendingConfirm(false);
  }, []);

  const saveBlock = canSaveConfig(config, models);

  const save = useCallback(async () => {
    if (!config) {
      return;
    }
    if (!canSaveConfig(config, models).ok) {
      return;
    }
    setIsSaving(true);
    setSaveStatus(null);
    try {
      const response = await authenticatedFetch('/api/vision-bridge/config', {
        method: 'PUT',
        body: JSON.stringify(buildUpdateInput(config, apiKeyRef.current)),
      });
      const payload = await toResponseJson<unknown>(response);
      if (!response.ok) {
        // Keep the OLD config on failure — never apply a half-saved state.
        setSaveStatus('error');
        return;
      }
      // On success, replace state with the freshly desensitized config.
      const next = reduceSaveResult(config, payload);
      if (next) {
        setConfig(next);
      }
      setSaveStatus('success');
      if (saveStatusTimerRef.current !== null) {
        window.clearTimeout(saveStatusTimerRef.current);
      }
      saveStatusTimerRef.current = window.setTimeout(() => {
        setSaveStatus(null);
        saveStatusTimerRef.current = null;
      }, 3000);
    } catch (error) {
      console.error('vision-bridge: failed to save settings', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  }, [config, models]);

  return {
    config,
    models,
    isLoading,
    isSaving,
    saveStatus,
    loadError,
    pendingConfirm,
    saveBlock,
    setField,
    setModel,
    setApiKey: (value: string) => {
      apiKeyRef.current = value;
    },
    requestEnable,
    confirmEnable,
    cancelConfirm,
    save,
    reload,
  };
}
