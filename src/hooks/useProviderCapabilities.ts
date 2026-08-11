import { useEffect, useState } from 'react';

import type { ProviderMcpCapabilities } from '../components/mcp/types';
import type { LLMProvider, ProviderCapabilityStatus } from '../types/app';
import { authenticatedFetch } from '../utils/api';

export type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsMcp: boolean;
  supportsSkills: boolean;
  supportsTokenUsage: boolean;
  supportsEffort: boolean;
  mcp: ProviderMcpCapabilities | null;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

export type ProviderCapabilitiesState = {
  status: ProviderCapabilityStatus;
  byProvider: Partial<Record<LLMProvider, ProviderCapabilities>>;
};

const INITIAL_STATE: ProviderCapabilitiesState = {
  status: 'loading',
  byProvider: {},
};

export function useProviderCapabilities(): ProviderCapabilitiesState {
  const [state, setState] = useState<ProviderCapabilitiesState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/capabilities');
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (!response.ok || !body.success || !Array.isArray(body.data?.providers)) {
          throw new Error(`Provider capabilities request failed (${response.status})`);
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }

        if (!cancelled) {
          setState({ status: 'ready', byProvider });
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading provider capabilities:', error);
          setState({ status: 'error', byProvider: {} });
        }
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
