import type { AgentCategoryContentSectionProps } from '../types';
import type { McpProject } from '../../../../../mcp/types';
import { McpServers } from '../../../../../mcp';
import type { SkillsProject } from '../../../../../skills/types';
import { ProviderSkills } from '../../../../../skills';

import AccountContent from './content/AccountContent';
import ProviderPermissionsContent from './content/ProviderPermissionsContent';

export default function AgentCategoryContentSection({
  selectedAgent,
  selectedCategory,
  agentContextById,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  projects,
  permissionModes,
  defaultPermissionMode,
  supportsMcp,
  mcpCapabilities,
  supportsSkills,
}: AgentCategoryContentSectionProps) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4">
      {selectedCategory === 'account' && (
        <AccountContent
          agent={selectedAgent}
          authStatus={agentContextById[selectedAgent].authStatus}
          onLogin={agentContextById[selectedAgent].onLogin}
        />
      )}

      {selectedCategory === 'permissions' && permissionModes.length > 0 && (
        <ProviderPermissionsContent
          agent={selectedAgent}
          permissionModes={permissionModes}
          defaultPermissionMode={defaultPermissionMode}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
        />
      )}

      {selectedCategory === 'mcp' && supportsMcp && mcpCapabilities && (
        // SettingsProject.name is populated from the DB projectId by
        // normalizeProjectForSettings, so we can map it straight through.
        <McpServers
          selectedProvider={selectedAgent}
          currentProjects={projects.map<McpProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
          mcpCapabilities={mcpCapabilities}
        />
      )}

      {selectedCategory === 'skills' && supportsSkills && (
        <ProviderSkills
          selectedProvider={selectedAgent}
          currentProjects={projects.map<SkillsProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
        />
      )}
    </div>
  );
}
