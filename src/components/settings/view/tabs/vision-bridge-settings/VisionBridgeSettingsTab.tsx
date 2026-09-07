import { useVisionBridgeSettings } from '../../../hooks/useVisionBridgeSettings';

import { VisionBridgeSettingsView } from './VisionBridgeSettingsView';

/**
 * Container tab: owns the hook state and renders the presentational view.
 * Wired into the settings dialog by `Settings.tsx`.
 */
export default function VisionBridgeSettingsTab() {
  const {
    config,
    models,
    isLoading,
    isSaving,
    saveStatus,
    loadError,
    saveBlock,
    pendingConfirm,
    setField,
    setModel,
    setApiKey,
    requestEnable,
    confirmEnable,
    cancelConfirm,
    save,
    reload,
  } = useVisionBridgeSettings();

  const handleEnabledToggle = (next: boolean) => {
    if (next) {
      // Moving from disabled to enabled requires the outbound confirmation.
      requestEnable();
    } else {
      setField('enabled', false);
    }
  };

  return (
    <VisionBridgeSettingsView
      config={config}
      models={models}
      isLoading={isLoading}
      isSaving={isSaving}
      saveStatus={saveStatus}
      loadError={loadError}
      saveBlock={saveBlock}
      pendingConfirm={pendingConfirm}
      onEnabledToggle={handleEnabledToggle}
      onConfirmEnable={confirmEnable}
      onCancelEnable={cancelConfirm}
      onFieldChange={setField}
      onModelChange={setModel}
      onApiKeyChange={setApiKey}
      onSave={save}
      onRetry={reload}
    />
  );
}
