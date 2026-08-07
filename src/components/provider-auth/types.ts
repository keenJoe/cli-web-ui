import type { LLMProvider } from '../../types/app';
import { PROVIDER_IDS } from '../llm-logo-provider/providerBranding';

export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

export const CLI_PROVIDERS: LLMProvider[] = PROVIDER_IDS;

export const PROVIDER_AUTH_STATUS_ENDPOINTS = Object.fromEntries(
  PROVIDER_IDS.map((provider) => [provider, `/api/providers/${provider}/auth/status`]),
) as Record<LLMProvider, string>;

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => (
  Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, {
    authenticated: false,
    email: null,
    method: null,
    error: null,
    loading,
  }])) as ProviderAuthStatusMap
);
