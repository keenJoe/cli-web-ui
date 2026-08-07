import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
  IProviderUsage,
  ProviderDefinition,
  ProviderDescriptor,
} from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * Shared provider base.
 *
 * Concrete providers expose their live runtime plus model, auth, MCP, skill,
 * session, and synchronization facets behind one registry-owned object.
 */
export abstract class AbstractProvider implements ProviderDefinition {
  readonly id: LLMProvider;
  abstract readonly descriptor: ProviderDescriptor;
  abstract readonly runtime: IProviderRuntime;
  abstract readonly models: IProviderModels;
  readonly mcp?: IProviderMcp;
  abstract readonly auth: IProviderAuth;
  readonly skills?: IProviderSkills;
  readonly usage?: IProviderUsage;
  abstract readonly sessions: IProviderSessions;
  abstract readonly sessionSynchronizer: IProviderSessionSynchronizer;

  protected constructor(id: LLMProvider) {
    this.id = id;
  }
}
