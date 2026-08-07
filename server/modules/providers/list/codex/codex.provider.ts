import { LegacyProviderRuntimeAdapter } from '@/modules/providers/adapters/legacy-provider-runtime.adapter.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexMcpProvider } from '@/modules/providers/list/codex/codex-mcp.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { CodexSkillsProvider } from '@/modules/providers/list/codex/codex-skills.provider.js';
import { CodexTokenUsageProvider } from '@/modules/providers/list/codex/codex-token-usage.provider.js';
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

/** Provider aggregate registered by ProviderRegistry for Codex capabilities and facets. */
export class CodexProvider extends AbstractProvider {
  readonly descriptor: ProviderDescriptor = {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsEffort: true,
  };
  readonly runtime: IProviderRuntime = new LegacyProviderRuntimeAdapter(codexRuntime);
  readonly models: IProviderModels = new CodexProviderModels();
  readonly mcp = new CodexMcpProvider();
  readonly auth: IProviderAuth = new CodexProviderAuth();
  readonly skills: IProviderSkills = new CodexSkillsProvider();
  readonly usage: IProviderUsage = new CodexTokenUsageProvider();
  readonly sessions: IProviderSessions = new CodexSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new CodexSessionSynchronizer();

  constructor() {
    super('codex');
  }
}
