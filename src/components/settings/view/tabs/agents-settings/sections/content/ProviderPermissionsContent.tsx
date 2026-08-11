import { Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  AgentProvider,
  ClaudePermissionsState,
  CodexPermissionMode,
  CursorPermissionsState,
} from '../../../../../types/types';

import PermissionsContent from './PermissionsContent';

type ProviderPermissionsContentProps = {
  agent: AgentProvider;
  permissionModes: string[];
  defaultPermissionMode: string | null;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  cursorPermissions: CursorPermissionsState;
  onCursorPermissionsChange: (value: CursorPermissionsState) => void;
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
};

function GenericPermissions({
  permissionModes,
  defaultPermissionMode,
}: Pick<ProviderPermissionsContentProps, 'permissionModes' | 'defaultPermissionMode'>) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Shield className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-medium text-foreground">
          {t('permissions.generic.title', { defaultValue: 'Permission modes' })}
        </h3>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {permissionModes.map((mode) => (
          <div key={mode} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
            <code className="break-all text-sm text-foreground">{mode}</code>
            {mode === defaultPermissionMode && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('permissions.generic.default', { defaultValue: 'Default' })}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ProviderPermissionsContent({
  agent,
  permissionModes,
  defaultPermissionMode,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
}: ProviderPermissionsContentProps) {
  if (agent === 'claude') {
    return (
      <PermissionsContent
        agent="claude"
        skipPermissions={claudePermissions.skipPermissions}
        onSkipPermissionsChange={(value) => {
          onClaudePermissionsChange({ ...claudePermissions, skipPermissions: value });
        }}
        allowedTools={claudePermissions.allowedTools}
        onAllowedToolsChange={(value) => {
          onClaudePermissionsChange({ ...claudePermissions, allowedTools: value });
        }}
        disallowedTools={claudePermissions.disallowedTools}
        onDisallowedToolsChange={(value) => {
          onClaudePermissionsChange({ ...claudePermissions, disallowedTools: value });
        }}
      />
    );
  }

  if (agent === 'cursor') {
    return (
      <PermissionsContent
        agent="cursor"
        skipPermissions={cursorPermissions.skipPermissions}
        onSkipPermissionsChange={(value) => {
          onCursorPermissionsChange({ ...cursorPermissions, skipPermissions: value });
        }}
        allowedCommands={cursorPermissions.allowedCommands}
        onAllowedCommandsChange={(value) => {
          onCursorPermissionsChange({ ...cursorPermissions, allowedCommands: value });
        }}
        disallowedCommands={cursorPermissions.disallowedCommands}
        onDisallowedCommandsChange={(value) => {
          onCursorPermissionsChange({ ...cursorPermissions, disallowedCommands: value });
        }}
      />
    );
  }

  if (agent === 'codex') {
    return (
      <PermissionsContent
        agent="codex"
        permissionMode={codexPermissionMode}
        onPermissionModeChange={onCodexPermissionModeChange}
      />
    );
  }

  return (
    <GenericPermissions
      permissionModes={permissionModes}
      defaultPermissionMode={defaultPermissionMode}
    />
  );
}
