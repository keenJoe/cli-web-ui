import { useEffect, useMemo, useState } from 'react';

import { useProviderCapabilities } from '../../../../../hooks/useProviderCapabilities';
import { PROVIDER_IDS } from '../../../../llm-logo-provider/providerBranding';
import type { AgentProvider, AgentCategory } from '../../../types/types';

import { getVisibleAgentCategories } from './agentCategoryVisibility';
import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const { status: capabilitiesStatus, byProvider: providerCapabilities } = useProviderCapabilities();
  const selectedCapabilities = capabilitiesStatus === 'ready'
    ? providerCapabilities[selectedAgent] ?? null
    : null;
  const selectedMcpCapabilities = selectedCapabilities?.supportsMcp === true
    ? selectedCapabilities.mcp ?? null
    : null;
  const visibleCategories = useMemo(
    () => getVisibleAgentCategories(selectedCapabilities
      ? {
          ...selectedCapabilities,
          supportsMcp: selectedMcpCapabilities !== null,
        }
      : null),
    [selectedCapabilities, selectedMcpCapabilities],
  );

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    return PROVIDER_IDS;
  }, []);

  const agentContextById = useMemo(
    () => Object.fromEntries(
      PROVIDER_IDS.map((providerId) => [
        providerId,
        {
          authStatus: providerAuthStatus[providerId],
          onLogin: () => onProviderLogin(providerId),
        },
      ]),
    ) as Record<AgentProvider, AgentContext>,
    [onProviderLogin, providerAuthStatus],
  );

  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      setSelectedCategory(visibleCategories[0] ?? 'account');
    }
  }, [selectedCategory, visibleCategories]);

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          categories={visibleCategories}
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <AgentCategoryContentSection
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          agentContextById={agentContextById}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          projects={projects}
          permissionModes={selectedCapabilities?.permissionModes ?? []}
          defaultPermissionMode={selectedCapabilities?.defaultPermissionMode ?? null}
          supportsMcp={selectedMcpCapabilities !== null}
          mcpCapabilities={selectedMcpCapabilities}
          supportsSkills={selectedCapabilities?.supportsSkills === true}
        />
      </div>
    </div>
  );
}
