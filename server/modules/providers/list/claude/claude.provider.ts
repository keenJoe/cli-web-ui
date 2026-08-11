import { LegacyProviderRuntimeAdapter } from '@/modules/providers/adapters/legacy-provider-runtime.adapter.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';
import { ClaudeTokenUsageProvider } from '@/modules/providers/list/claude/claude-token-usage.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
  IProviderUsage,
  ProviderDescriptor,
} from '@/shared/interfaces.js';

/** Provider aggregate registered by ProviderRegistry for Claude capabilities and facets. */
export class ClaudeProvider extends AbstractProvider {
  readonly descriptor: ProviderDescriptor = {
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsEffort: true,
  };
  readonly runtime: IProviderRuntime = new LegacyProviderRuntimeAdapter(claudeRuntime);
  readonly models: IProviderModels = new ClaudeProviderModels();
  readonly mcp = new ClaudeMcpProvider();
  readonly auth: IProviderAuth = new ClaudeProviderAuth();
  readonly skills: IProviderSkills = new ClaudeSkillsProvider();
  readonly usage: IProviderUsage = new ClaudeTokenUsageProvider();
  readonly sessions: IProviderSessions = new ClaudeSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new ClaudeSessionSynchronizer();

  constructor() {
    super('claude');
  }
}
