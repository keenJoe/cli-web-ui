import type { ProviderCapabilities } from '../../../../../hooks/useProviderCapabilities';
import type { AgentCategory } from '../../../types/types';

export function getVisibleAgentCategories(
  capabilities: Pick<ProviderCapabilities, 'permissionModes' | 'supportsMcp' | 'supportsSkills'> | null,
): AgentCategory[] {
  const categories: AgentCategory[] = ['account'];
  if (capabilities?.permissionModes.length) {
    categories.push('permissions');
  }
  if (capabilities?.supportsMcp) {
    categories.push('mcp');
  }
  if (capabilities?.supportsSkills) {
    categories.push('skills');
  }
  return categories;
}
