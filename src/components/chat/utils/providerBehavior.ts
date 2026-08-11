import type { LLMProvider } from '../../../types/app';
import type { PermissionGrantResult } from '../types/types';

import { grantClaudeToolPermission } from './chatPermissions';

type ToolPermissionGrant = (entry: string | null) => PermissionGrantResult;

// Cursor predates the generic `${provider}-settings` convention.
const TOOLS_SETTINGS_KEY_COMPATIBILITY: Readonly<Partial<Record<LLMProvider, string>>> = {
  cursor: 'cursor-tools-settings',
};

// Remembered tool grants are a Claude compatibility behavior. Other providers
// fail closed until they expose an equivalent capability-backed operation.
const TOOL_PERMISSION_GRANT_COMPATIBILITY: Readonly<Partial<Record<LLMProvider, ToolPermissionGrant>>> = {
  claude: grantClaudeToolPermission,
};

export function getProviderToolsSettingsStorageKey(provider: LLMProvider | string): string {
  return TOOLS_SETTINGS_KEY_COMPATIBILITY[provider as LLMProvider] ?? `${provider}-settings`;
}

export function grantProviderToolPermission(
  provider: LLMProvider | string,
  entry: string | null,
): PermissionGrantResult {
  return TOOL_PERMISSION_GRANT_COMPATIBILITY[provider as LLMProvider]?.(entry) ?? { success: false };
}
