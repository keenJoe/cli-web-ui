import { useEffect, useSyncExternalStore } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';
import {
  CLI_PROVIDERS,
  PROVIDER_AUTH_STATUS_ENDPOINTS,
  createInitialProviderAuthStatusMap,
} from '../types';
import type {
  ProviderAuthStatus,
  ProviderAuthStatusMap,
} from '../types';

type ProviderAuthStatusPayload = {
  installed?: boolean;
  authenticated?: boolean;
  email?: string | null;
  method?: string | null;
  error?: string | null;
};

type ProviderAuthStatusApiResponse = {
  success: boolean;
  data: ProviderAuthStatusPayload;
};

type ProviderAuthStatusErrorResponse = {
  error?: string | { message?: string };
};

const FALLBACK_STATUS_ERROR = 'Failed to check authentication status';
const FALLBACK_UNKNOWN_ERROR = 'Unknown error';

const toErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : FALLBACK_UNKNOWN_ERROR
);

const readStatusError = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as ProviderAuthStatusErrorResponse;
    const payloadError = payload.error;

    if (typeof payloadError === 'string' && payloadError) {
      return payloadError;
    }
    if (
      payloadError
      && typeof payloadError === 'object'
      && typeof payloadError.message === 'string'
      && payloadError.message
    ) {
      return payloadError.message;
    }
  } catch {
    // Keep the stable fallback when the server did not return JSON.
  }
  return `${FALLBACK_STATUS_ERROR} (HTTP ${response.status})`;
};

const toProviderAuthStatus = (
  payload: ProviderAuthStatusPayload,
  fallbackError: string | null = null,
): ProviderAuthStatus => ({
  installed: Boolean(payload.installed),
  authenticated: Boolean(payload.authenticated),
  email: payload.email ?? null,
  method: payload.method ?? null,
  error: payload.error ?? fallbackError,
  loading: false,
});

// Module-level singleton store: settings, onboarding, and the chat page share
// one status snapshot so a refresh anywhere propagates everywhere.
let providerAuthStatus: ProviderAuthStatusMap = createInitialProviderAuthStatusMap(true);
const statusSubscribers = new Set<() => void>();

const emitChange = () => {
  statusSubscribers.forEach((callback) => callback());
};

const subscribe = (callback: () => void): (() => void) => {
  statusSubscribers.add(callback);
  return () => {
    statusSubscribers.delete(callback);
  };
};

const getSnapshot = (): ProviderAuthStatusMap => providerAuthStatus;

const setProviderStatus = (provider: LLMProvider, status: ProviderAuthStatus) => {
  providerAuthStatus = {
    ...providerAuthStatus,
    [provider]: status,
  };
  emitChange();
};

const setProviderLoading = (provider: LLMProvider) => {
  setProviderStatus(provider, {
    ...providerAuthStatus[provider],
    loading: true,
    error: null,
  });
};

const checkProviderAuthStatus = async (provider: LLMProvider): Promise<ProviderAuthStatus> => {
  setProviderLoading(provider);

  try {
    const response = await authenticatedFetch(PROVIDER_AUTH_STATUS_ENDPOINTS[provider]);

    if (!response.ok) {
      const error = await readStatusError(response);
      const status: ProviderAuthStatus = {
        installed: false,
        authenticated: false,
        email: null,
        method: null,
        loading: false,
        error,
      };
      setProviderStatus(provider, status);
      return status;
    }

    const payload = (await response.json()) as ProviderAuthStatusApiResponse;
    const status = toProviderAuthStatus(payload.data);
    setProviderStatus(provider, status);
    return status;
  } catch (caughtError) {
    console.error(`Error checking ${provider} auth status:`, caughtError);
    const status: ProviderAuthStatus = {
      installed: false,
      authenticated: false,
      email: null,
      method: null,
      loading: false,
      error: toErrorMessage(caughtError),
    };
    setProviderStatus(provider, status);
    return status;
  }
};

const refreshProviderAuthStatuses = async (providers: LLMProvider[] = CLI_PROVIDERS) => {
  await Promise.all(providers.map((provider) => checkProviderAuthStatus(provider)));
};

const setProviderAuthStatus = (
  next: ProviderAuthStatusMap | ((previous: ProviderAuthStatusMap) => ProviderAuthStatusMap),
) => {
  providerAuthStatus = typeof next === 'function' ? next(providerAuthStatus) : next;
  emitChange();
};

// Refreshing on window focus is the shared-store invalidation hook: a login in
// another window/page is picked up by every consumer on the next focus.
let windowFocusRefreshInstalled = false;
const installWindowFocusRefresh = () => {
  if (windowFocusRefreshInstalled || typeof window === 'undefined') {
    return;
  }
  windowFocusRefreshInstalled = true;
  window.addEventListener('focus', () => {
    void refreshProviderAuthStatuses();
  });
};

type UseProviderAuthStatusOptions = {
  initialLoading?: boolean;
};

export function useProviderAuthStatus(
  { initialLoading: _initialLoading = true }: UseProviderAuthStatusOptions = {},
) {
  const providerAuthStatusSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    installWindowFocusRefresh();
  }, []);

  return {
    providerAuthStatus: providerAuthStatusSnapshot,
    setProviderAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  };
}
