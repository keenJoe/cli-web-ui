import { GitBranchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ComposerGitStatus } from '../../hooks/useComposerGitStatus';

type GitBranchChipProps = {
  /** Current git status for the selected project; null while loading. */
  gitStatus: ComposerGitStatus | null;
  /** Switches the main view to the GitPanel tab. */
  onOpenGitPanel: () => void;
};

/** Max rendered width of the branch name before it ellipses (spec: 140px). */
const BRANCH_MAX_WIDTH_PX = 140;

/**
 * Compact git branch + uncommitted-count chip rendered in the ChatComposer
 * footer. Clicking it opens the GitPanel tab; it performs no git writes and
 * shows no file list. Hides entirely (no layout footprint) for non-repos, and
 * is the first optional footer control hidden on narrow viewports.
 */
export default function GitBranchChip({ gitStatus, onOpenGitPanel }: GitBranchChipProps) {
  const { t } = useTranslation('chat');

  if (!gitStatus || !gitStatus.isGitRepository) {
    return null;
  }

  const showCount = gitStatus.uncommittedCount > 0;
  const tooltip = t('input.gitBranch.tooltip', {
    defaultValue: 'Open git panel',
  });
  const branchAria = t('input.gitBranch.branch', {
    branch: gitStatus.branch,
    count: gitStatus.uncommittedCount,
    defaultValue: 'Git branch {{branch}} with {{count}} uncommitted changes',
  });

  return (
    <button
      type="button"
      onClick={onOpenGitPanel}
      title={tooltip}
      aria-label={branchAria}
      className={[
        // `md:flex` (not `sm:flex`) so this chip hides before the "clear
        // input" button (sm:flex) when the viewport narrows — it is the first
        // optional footer control to disappear, preserving core input+send.
        'hidden md:inline-flex',
        'h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        gitStatus.isDetached ? 'text-muted-foreground/70 italic' : 'text-muted-foreground',
      ].join(' ')}
    >
      <GitBranchIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span
        className={[
          'truncate font-medium',
          gitStatus.isDetached ? 'italic' : 'text-foreground',
        ].join(' ')}
        style={{ maxWidth: BRANCH_MAX_WIDTH_PX }}
      >
        {gitStatus.branch || '—'}
      </span>
      {showCount && (
        <span
          className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground"
          aria-hidden
        >
          {gitStatus.uncommittedCount}
        </span>
      )}
    </button>
  );
}
