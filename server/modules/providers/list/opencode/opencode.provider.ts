import { LegacyProviderRuntimeAdapter } from '@/modules/providers/adapters/legacy-provider-runtime.adapter.js';
import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';
import { OpenCodeProviderModels } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { OpenCodeMcpProvider } from '@/modules/providers/list/opencode/opencode-mcp.provider.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { OpenCodeSkillsProvider } from '@/modules/providers/list/opencode/opencode-skills.provider.js';
import { OpenCodeTokenUsageProvider } from '@/modules/providers/list/opencode/opencode-token-usage.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
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

/** Provider aggregate registered by ProviderRegistry for OpenCode capabilities and facets. */
export class OpenCodeProvider extends AbstractProvider {
  readonly descriptor: ProviderDescriptor = {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsEffort: true,
  };
  readonly runtime: IProviderRuntime = new LegacyProviderRuntimeAdapter(opencodeRuntime);
  readonly models: IProviderModels = new OpenCodeProviderModels();
  readonly mcp = new OpenCodeMcpProvider();
  readonly auth: IProviderAuth = new OpenCodeProviderAuth();
  readonly skills: IProviderSkills = new OpenCodeSkillsProvider();
  readonly usage: IProviderUsage = new OpenCodeTokenUsageProvider();
  readonly sessions: IProviderSessions = new OpenCodeSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new OpenCodeSessionSynchronizer();

  constructor() {
    super('opencode');
  }
}
