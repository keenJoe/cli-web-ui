import {
  PROVIDER_BRANDS,
  PROVIDER_IDS,
} from '../llm-logo-provider/providerBranding';

import type { McpFormState, McpProvider, ProviderMcpCapabilities } from './types';

export const MCP_PROVIDER_NAMES = Object.fromEntries(
  PROVIDER_IDS.map((provider) => [provider, PROVIDER_BRANDS[provider].displayName]),
) as Record<McpProvider, string>;

export const GLOBAL_MCP_CAPABILITIES: ProviderMcpCapabilities = {
  supportedScopes: ['user', 'project'],
  supportedTransports: ['stdio', 'http'],
  supportsWorkingDirectory: false,
  supportsEnvironmentVariableReferences: false,
};

export const MCP_PROVIDER_BUTTON_CLASSES = Object.fromEntries(
  PROVIDER_IDS.map((provider) => [
    provider,
    'bg-primary text-primary-foreground hover:bg-primary/90',
  ]),
) as Record<McpProvider, string>;

export const DEFAULT_MCP_FORM: McpFormState = {
  name: '',
  scope: 'user',
  workspacePath: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
};
