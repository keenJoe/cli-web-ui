import {
  ProviderRegistry,
  providerRegistry,
} from '@/modules/providers/provider.registry.js';
import type { ProviderDefinition } from '@/shared/interfaces.js';
import type { LLMProvider, McpScope, McpTransport } from '@/shared/types.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether general file attachments can be included in a chat.send. */
  supportsFiles: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether this provider registered an MCP facet. */
  supportsMcp: boolean;
  /** Whether this provider registered a skills facet. */
  supportsSkills: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
  /** Provider-owned MCP configuration features, or null when no MCP facet exists. */
  mcp: {
    supportedScopes: McpScope[];
    supportedTransports: McpTransport[];
    supportsWorkingDirectory: boolean;
    supportsEnvironmentVariableReferences: boolean;
  } | null;
};

function buildCapabilities(definition: ProviderDefinition): ProviderCapabilities {
  return {
    provider: definition.id,
    permissionModes: [...definition.descriptor.permissionModes],
    defaultPermissionMode: definition.descriptor.defaultPermissionMode,
    supportsImages: definition.descriptor.supportsImages,
    supportsFiles: definition.descriptor.supportsFiles,
    supportsAbort: definition.descriptor.supportsAbort,
    supportsPermissionRequests: definition.descriptor.supportsPermissionRequests,
    supportsEffort: definition.descriptor.supportsEffort,
    supportsMcp: Boolean(definition.mcp),
    supportsSkills: Boolean(definition.skills),
    supportsTokenUsage: Boolean(definition.usage),
    mcp: definition.mcp
      ? {
          supportedScopes: [...definition.mcp.supportedScopes],
          supportedTransports: [...definition.mcp.supportedTransports],
          supportsWorkingDirectory: definition.mcp.supportsWorkingDirectory,
          supportsEnvironmentVariableReferences: definition.mcp.supportsEnvironmentVariableReferences,
        }
      : null,
  };
}

/**
 * Creates the capability service used by provider routes and registry contract
 * tests. Every response is projected from the supplied live registry.
 */
export function createProviderCapabilitiesService(registry: ProviderRegistry = providerRegistry) {
  return {
    getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
      return buildCapabilities(registry.resolveProvider(provider));
    },

    listAllProviderCapabilities(): ProviderCapabilities[] {
      return registry.listProviders().map(buildCapabilities);
    },
  };
}

/** Application singleton consumed by the provider capability route. */
export const providerCapabilitiesService = createProviderCapabilitiesService();
