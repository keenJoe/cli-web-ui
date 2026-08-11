import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { PiProvider } from '@/modules/providers/list/pi/pi.provider.js';
import type { IProvider, ProviderDefinition } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

type ProviderFacetName = Exclude<keyof IProvider, 'id'>;

/**
 * Registry used by provider application services to resolve definitions and
 * require optional facets without provider-id branches.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDefinition>();

  constructor(definitions: readonly ProviderDefinition[] = []) {
    definitions.forEach((definition) => this.registerProvider(definition));
  }

  /** Registers one complete definition after validating its static descriptor. */
  registerProvider(definition: ProviderDefinition): void {
    const { defaultPermissionMode, permissionModes } = definition.descriptor;
    if (permissionModes.length === 0 || !permissionModes.includes(defaultPermissionMode)) {
      throw new AppError(
        `Provider "${definition.id}" has an invalid capability descriptor.`,
        {
          code: 'PROVIDER_DESCRIPTOR_INVALID',
          statusCode: 500,
        },
      );
    }

    this.providers.set(definition.id, definition);
  }

  /** Returns registered definitions in deterministic registration order. */
  listProviders(): ProviderDefinition[] {
    return [...this.providers.values()];
  }

  /** Resolves one definition or rejects an unknown provider with a stable error. */
  resolveProvider(provider: string): ProviderDefinition {
    const resolvedProvider = this.providers.get(provider);
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  }

  /** Resolves a facet and distinguishes unknown providers from unsupported capability. */
  requireFacet<Facet extends ProviderFacetName>(
    provider: string,
    facet: Facet,
  ): NonNullable<ProviderDefinition[Facet]> {
    const definition = this.resolveProvider(provider);
    const resolvedFacet = definition[facet];
    if (resolvedFacet === undefined || resolvedFacet === null) {
      throw new AppError(`Provider "${provider}" does not support the "${facet}" capability.`, {
        code: 'PROVIDER_CAPABILITY_UNSUPPORTED',
        statusCode: 400,
      });
    }

    return resolvedFacet as NonNullable<ProviderDefinition[Facet]>;
  }
}

/** Singleton consumed by provider services and the server assembly root. */
export const providerRegistry = new ProviderRegistry([
  new ClaudeProvider(),
  new CodexProvider(),
  new CursorProvider(),
  new OpenCodeProvider(),
  new PiProvider(),
]);
