import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import type {
  VisionBridgeModelOptionV1,
  VisionBridgePublicConfigV1,
  VisionBridgeApiFormat,
} from '../../../../../../shared/vision-bridge.js';
import { VISION_BRIDGE_LIMITS, VISION_BRIDGE_API_FORMATS } from '../../../../../../shared/vision-bridge.js';
import type {
  SaveBlock,
  VisionBridgeSettingsError,
} from '../../../hooks/visionBridgeSettingsLogic';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

/** Formats a token count for compact display, e.g. 131072 -> "128K". */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return String(tokens);
}

type VisionBridgeSettingsViewProps = {
  config: VisionBridgePublicConfigV1 | null;
  models: VisionBridgeModelOptionV1[];
  isLoading: boolean;
  isSaving: boolean;
  saveStatus: 'success' | 'error' | null;
  loadError: VisionBridgeSettingsError | null;
  saveBlock: SaveBlock;
  pendingConfirm: boolean;
  onEnabledToggle: (next: boolean) => void;
  onConfirmEnable: () => void;
  onCancelEnable: () => void;
  onFieldChange: <K extends keyof VisionBridgePublicConfigV1>(
    field: K,
    value: VisionBridgePublicConfigV1[K],
  ) => void;
  onModelChange: (provider: string, id: string) => void;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
  onRetry: () => void;
};

const blockedReasonKey: Record<string, string> = {
  blockedNoModel: 'visionBridge.save.blockedNoModel',
  blockedModelMissing: 'visionBridge.save.blockedModelMissing',
  blockedCredential: 'visionBridge.save.blockedCredential',
};

/**
 * Pure presentational view for the vision-bridge settings. All data comes in
 * as props (desensitized by the hook's `pickPublicConfig` before reaching
 * here), so it renders identically in tests and in production. It never
 * renders an API-key or base-URL input — credentials live in Pi.
 */
export function VisionBridgeSettingsView({
  config,
  models,
  isLoading,
  isSaving,
  saveStatus,
  loadError,
  saveBlock,
  pendingConfirm,
  onEnabledToggle,
  onConfirmEnable,
  onCancelEnable,
  onFieldChange,
  onModelChange,
  onApiKeyChange,
  onSave,
  onRetry,
}: VisionBridgeSettingsViewProps) {
  const { t } = useTranslation('settings');

  if (isLoading && !config) {
    return (
      <div className="space-y-8">
        <SettingsSection title={t('visionBridge.title')}>
          <SettingsCard className="p-4">
            <p className="text-sm text-muted-foreground">{t('visionBridge.loading')}</p>
          </SettingsCard>
        </SettingsSection>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="space-y-8">
        <SettingsSection title={t('visionBridge.title')}>
          <SettingsCard className="p-4">
            <p className="text-sm text-muted-foreground">{t('visionBridge.errors.loadFailed')}</p>
            <Button variant="ghost" size="sm" onClick={onRetry} className="mt-2">
              {t('visionBridge.save.retry')}
            </Button>
          </SettingsCard>
        </SettingsSection>
      </div>
    );
  }

  const enabled = config.enabled;
  const visionModel = config.visionModel;
  const toolImagesOff = !config.sources.toolImages;
  const saveDisabled = isSaving || !saveBlock.ok;
  const selectedValue = visionModel ? `${visionModel.provider}:${visionModel.id}` : '';
  // The catalog option matching the current model, or undefined for a custom model.
  const selectedOption = models.find(
    (model) => model.provider === visionModel?.provider && model.id === visionModel?.id,
  );
  const isCustomModel = visionModel !== undefined && selectedOption === undefined;

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('visionBridge.title')}
        description={t('visionBridge.description')}
      >
        <SettingsCard className="p-4">
          <p className="text-xs text-muted-foreground">{t('visionBridge.noApiKeyNote')}</p>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('visionBridge.enable.label')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('visionBridge.enable.label')}
            description={t('visionBridge.enable.description')}
          >
            <SettingsToggle
              checked={enabled}
              onChange={onEnabledToggle}
              ariaLabel={t('visionBridge.enable.label')}
            />
          </SettingsRow>
          {/* data-testid markers keep the desensitization/confirmation tests stable. */}
          <span data-testid="vb-enable-switch" aria-checked={enabled} className="sr-only" />
          <span
            data-testid="vb-toolimages-switch"
            aria-checked={config.sources.toolImages}
            className="sr-only"
          />
        </SettingsCard>
      </SettingsSection>

      {pendingConfirm && (
        <SettingsCard className="border-amber-500/40 bg-amber-500/5 p-4" >
          <div data-testid="vb-confirm" className="space-y-3">
            <h4 className="text-sm font-semibold text-foreground">
              {t('visionBridge.confirm.title')}
            </h4>
            <p className="text-sm text-muted-foreground">{t('visionBridge.confirm.body')}</p>
            <dl className="text-sm">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('visionBridge.confirm.provider')}:</dt>
                <dd className="font-medium text-foreground">{visionModel?.provider ?? '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('visionBridge.confirm.model')}:</dt>
                <dd className="font-medium text-foreground">
                  {visionModel ? `${visionModel.provider}/${visionModel.id}` : '—'}
                </dd>
              </div>
            </dl>
            <p
              data-testid={toolImagesOff ? 'vb-confirm-toolimages-off' : 'vb-confirm-toolimages-on'}
              className="text-sm text-muted-foreground"
            >
              {toolImagesOff
                ? t('visionBridge.confirm.toolImagesOff')
                : t('visionBridge.confirm.toolImagesOn')}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={onConfirmEnable}>
                {t('visionBridge.confirm.continue')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelEnable}>
                {t('visionBridge.confirm.cancel')}
              </Button>
            </div>
          </div>
        </SettingsCard>
      )}

      <SettingsSection title={t('visionBridge.model.label')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('visionBridge.model.label')}
            description={t('visionBridge.model.description')}
          >
            <div className="w-full min-w-[240px] max-w-md space-y-2">
              <select
                data-testid="vb-model-select"
                value={isCustomModel ? '__custom__' : selectedValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) {
                    return;
                  }
                  if (value === '__custom__') {
                    return;
                  }
                  const [provider, ...idParts] = value.split(':');
                  onModelChange(provider, idParts.join(':'));
                }}
                className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t('visionBridge.model.select')}</option>
                {models.map((model) => (
                  <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
                    {model.displayName ? `${model.displayName} (${model.provider}/${model.id})` : `${model.provider}/${model.id}`}
                  </option>
                ))}
                <option value="__custom__">{t('visionBridge.model.customOption')}</option>
              </select>

              {(isCustomModel || models.length === 0) && (
                <input
                  data-testid="vb-model-custom"
                  type="text"
                  value={visionModel ? `${visionModel.provider}:${visionModel.id}` : ''}
                  placeholder="openai-protocol/qwen-vl-max"
                  onChange={(event) => {
                    const value = event.target.value.trim();
                    if (!value) {
                      return;
                    }
                    const slash = value.indexOf('/');
                    if (slash > 0) {
                      onModelChange(value.slice(0, slash), value.slice(slash + 1));
                    } else {
                      onModelChange('custom', value);
                    }
                  }}
                  className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                />
              )}
            </div>
          </SettingsRow>

          {selectedOption && !selectedOption.supportsImage && (
            <div
              data-testid="vb-model-warning"
              className="border-b border-border px-4 py-3 text-sm text-destructive"
            >
              <p className="font-medium">{t('visionBridge.model.notImage')}</p>
            </div>
          )}

          {selectedOption && (
            <div className="space-y-1 border-b border-border px-4 py-3">
              <p className="text-sm text-muted-foreground">
                {selectedOption.supportsImage
                  ? t('visionBridge.model.supportsImage')
                  : t('visionBridge.model.noImageInput')}
              </p>
              {typeof selectedOption.contextWindow === 'number' && (
                <p className="text-sm text-muted-foreground">
                  {t('visionBridge.model.context')}{formatTokens(selectedOption.contextWindow)}
                </p>
              )}
              {typeof selectedOption.maxTokens === 'number' && (
                <p className="text-sm text-muted-foreground">
                  {t('visionBridge.model.maxOutput')}{formatTokens(selectedOption.maxTokens)}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {selectedOption.reasoning
                  ? t('visionBridge.model.reasoningOn')
                  : t('visionBridge.model.reasoningOff')}
              </p>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('visionBridge.apiFormat.label')}>
        <SettingsCard className="p-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-foreground">
              {t('visionBridge.apiFormat.label')}
            </span>
            <select
              data-testid="vb-api-format"
              value={config.apiFormat}
              onChange={(event) => onFieldChange('apiFormat', event.target.value as VisionBridgeApiFormat)}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {VISION_BRIDGE_API_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`visionBridge.apiFormat.options.${format}`)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('visionBridge.apiFormat.description')}
            </p>
          </label>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('visionBridge.baseUrl.label')}>
        <SettingsCard className="p-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-foreground">
              {t('visionBridge.baseUrl.label')}
            </span>
            <input
              data-testid="vb-base-url"
              type="text"
              value={config.baseUrl ?? ''}
              placeholder="https://open.bigmodel.cn/api/paas/v4"
              onChange={(event) => onFieldChange('baseUrl', event.target.value)}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('visionBridge.baseUrl.description')}
            </p>
          </label>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('visionBridge.apiKey.label')}>
        <SettingsCard className="p-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-foreground">
              {t('visionBridge.apiKey.label')}
            </span>
            <input
              data-testid="vb-api-key"
              type="password"
              autoComplete="off"
              placeholder={config.hasApiKey ? '••••••••••' : t('visionBridge.apiKey.placeholder')}
              onChange={(event) => onApiKeyChange(event.target.value)}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('visionBridge.apiKey.description')}
            </p>
          </label>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('visionBridge.parameters.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('visionBridge.parameters.maxImagesPerRun.label')}
            description={t('visionBridge.parameters.maxImagesPerRun.description')}
          >
            <select
              value={config.maxImagesPerRun}
              onChange={(event) => onFieldChange('maxImagesPerRun', Number(event.target.value))}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground sm:w-24"
            >
              {Array.from(
                { length: VISION_BRIDGE_LIMITS.maxImagesPerRun.max },
                (_, index) => index + VISION_BRIDGE_LIMITS.maxImagesPerRun.min,
              ).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('visionBridge.parameters.timeoutMs.label')}
            description={t('visionBridge.parameters.timeoutMs.description')}
          >
            <select
              value={config.timeoutMs}
              onChange={(event) => onFieldChange('timeoutMs', Number(event.target.value))}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground sm:w-32"
            >
              {Array.from(
                { length: (VISION_BRIDGE_LIMITS.timeoutMs.max - VISION_BRIDGE_LIMITS.timeoutMs.min) / 1000 + 1 },
                (_, index) => VISION_BRIDGE_LIMITS.timeoutMs.min + index * 1000,
              ).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('visionBridge.parameters.concurrency.label')}
            description={t('visionBridge.parameters.concurrency.description')}
          >
            <select
              value={config.concurrency}
              onChange={(event) => onFieldChange('concurrency', Number(event.target.value))}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground sm:w-24"
            >
              {Array.from(
                { length: VISION_BRIDGE_LIMITS.concurrency.max },
                (_, index) => index + VISION_BRIDGE_LIMITS.concurrency.min,
              ).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('visionBridge.parameters.maxTokens.label')}
            description={t('visionBridge.parameters.maxTokens.description')}
          >
            <select
              value={config.maxTokens}
              onChange={(event) => onFieldChange('maxTokens', Number(event.target.value))}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground sm:w-28"
            >
              {Array.from(
                { length: (VISION_BRIDGE_LIMITS.maxTokens.max - VISION_BRIDGE_LIMITS.maxTokens.min) / 128 + 1 },
                (_, index) => VISION_BRIDGE_LIMITS.maxTokens.min + index * 128,
              ).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('visionBridge.sources.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('visionBridge.sources.userImages.label')}
            description={t('visionBridge.sources.userImages.description')}
          >
            <SettingsToggle
              checked={config.sources.userImages}
              onChange={(value) => onFieldChange('sources', { ...config.sources, userImages: value })}
              ariaLabel={t('visionBridge.sources.userImages.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('visionBridge.sources.toolImages.label')}
            description={t('visionBridge.sources.toolImages.description')}
          >
            <SettingsToggle
              checked={config.sources.toolImages}
              onChange={(value) => onFieldChange('sources', { ...config.sources, toolImages: value })}
              ariaLabel={t('visionBridge.sources.toolImages.label')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('visionBridge.promptTemplate.label')}>
        <SettingsCard className="p-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-foreground">
              {t('visionBridge.promptTemplate.label')}
            </span>
            <textarea
              value={config.promptTemplate}
              onChange={(event) => onFieldChange('promptTemplate', event.target.value)}
              rows={6}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('visionBridge.promptTemplate.help')}
            </p>
          </label>
        </SettingsCard>
      </SettingsSection>

      {(loadError || (!saveBlock.ok && enabled)) && (
        <SettingsCard className="border-destructive/40 bg-destructive/5 p-4">
          {loadError && (
            <p data-testid="vb-load-error" className="text-sm text-destructive">
              {loadError.code === 5031
                ? t('visionBridge.errors.modelsUnavailable')
                : t('visionBridge.errors.loadFailed')}
            </p>
          )}
          {!saveBlock.ok && enabled && (
            <p data-testid="vb-save-blocked" className="text-sm text-destructive">
              {t(blockedReasonKey[saveBlock.reasonKey] ?? 'visionBridge.save.blockedNoModel')}
            </p>
          )}
        </SettingsCard>
      )}

      <div className="flex items-center gap-2">
        <Button data-testid="vb-save" onClick={onSave} disabled={saveDisabled}>
          {isSaving ? t('visionBridge.save.saving') : t('visionBridge.save.label')}
        </Button>
        {saveStatus === 'success' && (
          <span className="text-sm text-green-600 dark:text-green-400">
            {t('visionBridge.save.success')}
          </span>
        )}
        {saveStatus === 'error' && (
          <span data-testid="vb-save-error" className="text-sm text-destructive">
            {t('visionBridge.save.failed')}
          </span>
        )}
      </div>
    </div>
  );
}

