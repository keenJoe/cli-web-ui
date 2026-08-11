import { LegacyProviderRuntimeAdapter } from '@/modules/providers/adapters/legacy-provider-runtime.adapter.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { CursorProviderAuth } from '@/modules/providers/list/cursor/cursor-auth.provider.js';
import { CursorProviderModels } from '@/modules/providers/list/cursor/cursor-models.provider.js';
import { cursorRuntime } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import { CursorMcpProvider } from '@/modules/providers/list/cursor/cursor-mcp.provider.js';
import { CursorSessionSynchronizer } from '@/modules/providers/list/cursor/cursor-session-synchronizer.provider.js';
import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { CursorSkillsProvider } from '@/modules/providers/list/cursor/cursor-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
  ProviderDescriptor,
} from '@/shared/interfaces.js';

/** Provider aggregate registered by ProviderRegistry for Cursor capabilities and facets. */
export class CursorProvider extends AbstractProvider {
  readonly descriptor: ProviderDescriptor = {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsEffort: false,
  };
  readonly runtime: IProviderRuntime = new LegacyProviderRuntimeAdapter(cursorRuntime);
  readonly models: IProviderModels = new CursorProviderModels();
  readonly mcp = new CursorMcpProvider();
  readonly auth: IProviderAuth = new CursorProviderAuth();
  readonly skills: IProviderSkills = new CursorSkillsProvider();
  readonly sessions: IProviderSessions = new CursorSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new CursorSessionSynchronizer();

  constructor() {
    super('cursor');
  }
}
