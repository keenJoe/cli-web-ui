import type {
  KeyValueMap,
  McpFormState,
  McpProvider,
  McpScope,
  McpTransport,
  ProviderMcpCapabilities,
  UpsertProviderMcpServerPayload,
} from '../types';

type CreateMcpPayloadOptions = ProviderMcpCapabilities & {
  unsupportedTransportMessage?: (transport: McpTransport) => string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const readStringArray = (value: unknown): string[] | undefined => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined
);

const readStringRecord = (value: unknown): KeyValueMap | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: KeyValueMap = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (typeof entry === 'string') {
      normalized[key] = entry;
    }
  });

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const formatKeyValueLines = (value: KeyValueMap): string => (
  Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join('\n')
);

export const parseKeyValueLines = (value: string): KeyValueMap => {
  const normalized: KeyValueMap = {};
  value.split('\n').forEach((line) => {
    const [key, ...valueParts] = line.split('=');
    if (key?.trim()) {
      normalized[key.trim()] = valueParts.join('=').trim();
    }
  });
  return normalized;
};

export const parseListLines = (value: string): string[] => (
  value.split('\n').map((entry) => entry.trim()).filter(Boolean)
);

export const maskSecret = (value: unknown): string => {
  const normalizedValue = String(value ?? '');
  if (normalizedValue.length <= 4) {
    return '****';
  }

  return `${normalizedValue.slice(0, 2)}****${normalizedValue.slice(-2)}`;
};

export const isMcpScope = (value: unknown): value is McpScope => (
  value === 'user' || value === 'local' || value === 'project'
);

export const isMcpTransport = (value: unknown): value is McpTransport => (
  value === 'stdio' || value === 'http' || value === 'sse'
);

export const getProjectPath = (project: { fullPath?: string; path?: string }): string => (
  project.fullPath || project.path || ''
);

export const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unknown error'
);

const assertSupportedTransport = (
  provider: McpProvider,
  transport: McpTransport,
  options: CreateMcpPayloadOptions,
) => {
  if (options.supportedTransports.includes(transport)) {
    return;
  }

  throw new Error(
    options.unsupportedTransportMessage?.(transport) ?? `${provider} does not support ${transport} MCP servers`,
  );
};

const requireMcpCapabilities = (
  options: CreateMcpPayloadOptions | undefined,
): CreateMcpPayloadOptions => {
  if (!options) {
    throw new Error('MCP capabilities are unavailable');
  }

  return options;
};

const assertSupportedScope = (
  provider: McpProvider,
  scope: McpScope,
  options: CreateMcpPayloadOptions,
) => {
  if (!options.supportedScopes.includes(scope)) {
    throw new Error(`${provider} does not support ${scope} MCP scope`);
  }
};

export const parseJsonMcpPayload = (
  provider: McpProvider,
  formData: McpFormState,
  options?: CreateMcpPayloadOptions,
): UpsertProviderMcpServerPayload => {
  const capabilities = requireMcpCapabilities(options);
  const parsed = JSON.parse(formData.jsonInput) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('JSON configuration must be an object');
  }

  const transportInput = readString(parsed.transport) ?? readString(parsed.type);
  const transport = isMcpTransport(transportInput) ? transportInput : undefined;
  if (!transport) {
    throw new Error('Missing required field: type');
  }

  assertSupportedScope(provider, formData.scope, capabilities);
  assertSupportedTransport(provider, transport, capabilities);

  if (transport === 'stdio' && !readString(parsed.command)) {
    throw new Error('stdio type requires a command field');
  }

  if ((transport === 'http' || transport === 'sse') && !readString(parsed.url)) {
    throw new Error(`${transport} type requires a url field`);
  }

  return {
    name: formData.name.trim(),
    scope: formData.scope,
    workspacePath: formData.scope === 'user' ? undefined : formData.workspacePath,
    transport,
    command: readString(parsed.command),
    args: readStringArray(parsed.args) ?? [],
    env: readStringRecord(parsed.env) ?? {},
    cwd: capabilities.supportsWorkingDirectory
      ? readString(parsed.cwd)
      : undefined,
    url: readString(parsed.url),
    headers: readStringRecord(parsed.headers ?? parsed.http_headers) ?? {},
    envVars: capabilities.supportsEnvironmentVariableReferences
      ? readStringArray(parsed.envVars ?? parsed.env_vars) ?? []
      : undefined,
    bearerTokenEnvVar: capabilities.supportsEnvironmentVariableReferences
      ? readString(parsed.bearerTokenEnvVar ?? parsed.bearer_token_env_var)
      : undefined,
    envHttpHeaders: capabilities.supportsEnvironmentVariableReferences
      ? readStringRecord(parsed.envHttpHeaders ?? parsed.env_http_headers) ?? {}
      : undefined,
  };
};

export const createMcpPayloadFromForm = (
  provider: McpProvider,
  formData: McpFormState,
  options?: CreateMcpPayloadOptions,
): UpsertProviderMcpServerPayload => {
  const capabilities = requireMcpCapabilities(options);
  if (formData.importMode === 'json') {
    return parseJsonMcpPayload(provider, formData, capabilities);
  }

  assertSupportedScope(provider, formData.scope, capabilities);
  assertSupportedTransport(provider, formData.transport, capabilities);

  const supportsWorkingDirectory = capabilities.supportsWorkingDirectory;
  const supportsEnvironmentVariableReferences = capabilities.supportsEnvironmentVariableReferences;

  return {
    name: formData.name.trim(),
    scope: formData.scope,
    workspacePath: formData.scope === 'user' ? undefined : formData.workspacePath,
    transport: formData.transport,
    command: formData.transport === 'stdio' ? formData.command.trim() : undefined,
    args: formData.transport === 'stdio' ? formData.args : undefined,
    env: formData.env,
    cwd: supportsWorkingDirectory ? formData.cwd.trim() || undefined : undefined,
    url: formData.transport !== 'stdio' ? formData.url.trim() : undefined,
    headers: formData.transport !== 'stdio' ? formData.headers : undefined,
    envVars: supportsEnvironmentVariableReferences ? formData.envVars : undefined,
    bearerTokenEnvVar: supportsEnvironmentVariableReferences
      ? formData.bearerTokenEnvVar.trim() || undefined
      : undefined,
    envHttpHeaders: supportsEnvironmentVariableReferences ? formData.envHttpHeaders : undefined,
  };
};
