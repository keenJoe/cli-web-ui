import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import GitBranchChip from './GitBranchChip';
import type { ComposerGitStatus } from '../../hooks/useComposerGitStatus';

const normal = (overrides: Partial<ComposerGitStatus> = {}): ComposerGitStatus => ({
  branch: 'develop',
  uncommittedCount: 3,
  isDetached: false,
  isGitRepository: true,
  ...overrides,
});

test('S04 non-git repository renders nothing (no layout footprint)', () => {
  assert.equal(renderToStaticMarkup(<GitBranchChip gitStatus={normal({ isGitRepository: false })} onOpenGitPanel={() => {}} />), '');
  assert.equal(renderToStaticMarkup(<GitBranchChip gitStatus={null} onOpenGitPanel={() => {}} />), '');
});

test('S02 clean working tree renders the chip without a count badge', () => {
  const html = renderToStaticMarkup(<GitBranchChip gitStatus={normal({ uncommittedCount: 0 })} onOpenGitPanel={() => {}} />);
  assert.match(html, /develop/);
  assert.doesNotMatch(html, /bg-primary/);
});

test('S01 normal repo renders branch name and a count badge when count > 0', () => {
  const html = renderToStaticMarkup(<GitBranchChip gitStatus={normal()} onOpenGitPanel={() => {}} />);
  assert.match(html, /develop/);
  // The count badge carries the primary background and the numeric count.
  assert.match(html, /bg-primary/);
  assert.match(html, />3</);
});

test('S03 detached HEAD renders italic styling with the short hash', () => {
  const html = renderToStaticMarkup(
    <GitBranchChip gitStatus={normal({ branch: 'a1b2c3d', isDetached: true, uncommittedCount: 0 })} onOpenGitPanel={() => {}} />,
  );
  assert.match(html, /a1b2c3d/);
  assert.match(html, /italic/);
});

test('S06 branch name is clamped to 140px and truncated', () => {
  const html = renderToStaticMarkup(<GitBranchChip gitStatus={normal({ branch: 'feature/very-long-branch-name' })} onOpenGitPanel={() => {}} />);
  assert.match(html, /truncate/);
  assert.match(html, /max-width:\s*140px/);
});

test('S21 special characters in branch name are escaped, not injected', () => {
  const html = renderToStaticMarkup(
    <GitBranchChip gitStatus={normal({ branch: '<script>alert(1)</script>' })} onOpenGitPanel={() => {}} />,
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
