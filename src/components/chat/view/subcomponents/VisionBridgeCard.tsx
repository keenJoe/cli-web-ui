import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { VisionBridgeCard as VisionBridgeCardData } from '../../../../stores/visionBridgeState';

/**
 * Status metadata per vision-bridge terminal phase. The success card shows the
 * derived description as content; non-success cards only show a sanitized
 * status label and (when present) a sanitized error message. Original user
 * images are rendered separately by `ChatMessageImages` (design.md D4).
 */
const PHASE_STYLE: Record<string, { tone: string; dot: string }> = {
  succeeded: { tone: 'text-green-600 dark:text-green-400', dot: 'bg-green-400 dark:bg-green-500' },
  failed: { tone: 'text-red-600 dark:text-red-400', dot: 'bg-red-400 dark:bg-red-500' },
  skipped: { tone: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-400 dark:bg-amber-500' },
  cancelled: { tone: 'text-gray-500 dark:text-gray-400', dot: 'bg-gray-400 dark:bg-gray-500' },
  processing: { tone: 'text-blue-600 dark:text-blue-400', dot: 'bg-blue-400 dark:bg-blue-500' },
};

function phaseLabel(t: (key: string, opts?: Record<string, unknown>) => string, phase: string): string {
  switch (phase) {
    case 'succeeded':
      return t('visionBridge.status.succeeded');
    case 'failed':
      return t('visionBridge.status.failed');
    case 'skipped':
      return t('visionBridge.status.skipped');
    case 'cancelled':
      return t('visionBridge.status.cancelled');
    case 'started':
      return t('visionBridge.status.processing');
    default:
      return t('visionBridge.status.processing');
  }
}

interface VisionBridgeCardProps {
  card: VisionBridgeCardData;
}

/**
 * Renders one structured vision-bridge card. The card is attached to its
 * originating user message / tool result by the caller (anchored on
 * `clientMessageId` / `toolCallId` / unique `sourceEntryId`), or rendered once
 * at the session level when no unique anchor exists.
 *
 * The card never trusts natural-language markers: it only renders state that
 * arrived via the structured `vision_bridge` ProviderRunEvent or the persisted
 * `cloudcli.vision-bridge.v1` session entry. Success descriptions are derived
 * content; failure reasons are sanitized (design.md D4/D10).
 */
function VisionBridgeCardImpl({ card }: VisionBridgeCardProps) {
  const { t } = useTranslation('chat');
  const isUnbound = card.anchor.kind === 'unbound';

  return (
    <div
      data-testid="vision-bridge-card"
      data-anchor={card.anchor.kind}
      className={`rounded-lg border border-border/60 bg-muted/40 p-3 text-sm ${
        isUnbound ? 'mx-auto w-full max-w-[54.25rem]' : ''
      }`}
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="inline-block h-3 w-3 rounded-full bg-violet-400 dark:bg-violet-500" aria-hidden="true" />
        <span>{t('visionBridge.title')}</span>
        {isUnbound && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
            {t('visionBridge.unboundSource')}
          </span>
        )}
      </div>

      <ul className="space-y-2">
        {card.items.map((item) => {
          const phase = item.phase === 'started' ? 'processing' : item.phase;
          const style = PHASE_STYLE[phase] ?? PHASE_STYLE.processing;
          return (
            <li key={item.observationId} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
                <span className={`text-xs font-medium ${style.tone}`}>
                  {t('visionBridge.image', { index: item.imageIndex })}
                </span>
                <span className={`text-xs ${style.tone}`}>{phaseLabel(t, phase)}</span>
                {item.cached && (
                  <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    {t('visionBridge.cached')}
                  </span>
                )}
              </div>
              {phase === 'succeeded' && typeof item.description === 'string' && item.description.trim() && (
                <p dir="auto" className="whitespace-pre-wrap break-words text-xs text-foreground/80">
                  {item.description}
                </p>
              )}
              {phase !== 'succeeded' && typeof item.errorMessage === 'string' && item.errorMessage.trim() && (
                <p dir="auto" className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {item.errorMessage}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const VisionBridgeCard = memo(VisionBridgeCardImpl);
export default VisionBridgeCard;
