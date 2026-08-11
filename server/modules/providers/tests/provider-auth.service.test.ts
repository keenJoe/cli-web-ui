import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const createServiceWithStatus = (status: ProviderAuthStatus) => ({
  ...providerAuthService,
  getProviderAuthStatus: async () => status,
});

test('assertProviderAuthenticated passes for an installed and authenticated provider', async () => {
  const service = createServiceWithStatus({
    installed: true,
    provider: 'claude',
    authenticated: true,
    email: 'user@example.com',
    method: 'api_key',
  });

  await assert.doesNotReject(() => service.assertProviderAuthenticated('claude'));
});

test('assertProviderAuthenticated rejects an uninstalled provider with 401', async () => {
  const service = createServiceWithStatus({
    installed: false,
    provider: 'claude',
    authenticated: false,
    email: null,
    method: null,
  });

  await assert.rejects(
    () => service.assertProviderAuthenticated('claude'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROVIDER_NOT_AUTHENTICATED');
      assert.equal(error.statusCode, 401);
      assert.equal(error.message, 'provider 未安装或未认证');
      return true;
    },
  );
});

test('assertProviderAuthenticated rejects an installed but unauthenticated provider with 401', async () => {
  const service = createServiceWithStatus({
    installed: true,
    provider: 'claude',
    authenticated: false,
    email: null,
    method: null,
  });

  await assert.rejects(
    () => service.assertProviderAuthenticated('claude'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROVIDER_NOT_AUTHENTICATED');
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
});

const authenticatedStatus: ProviderAuthStatus = {
  installed: true,
  provider: 'pi',
  authenticated: true,
  email: 'pi@example.com',
  method: 'rpc',
};

const mockAuthProbe = (t: test.TestContext, probe: () => Promise<ProviderAuthStatus> | ProviderAuthStatus) => {
  t.mock.method(providerRegistry, 'resolveProvider', () => ({
    auth: { getStatus: probe },
  }) as unknown as IProvider);
};

test('getProviderAuthStatus reuses a cached status within the TTL without re-probing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  let probeCount = 0;
  mockAuthProbe(t, async () => {
    probeCount += 1;
    return authenticatedStatus;
  });

  const first = await providerAuthService.getProviderAuthStatus('pi');
  const second = await providerAuthService.getProviderAuthStatus('pi');

  assert.equal(first, authenticatedStatus);
  assert.equal(second, authenticatedStatus);
  assert.equal(probeCount, 1);
});

test('getProviderAuthStatus merges concurrent probes into one in-flight request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 20_000_000 });
  let probeCount = 0;
  let release!: (status: ProviderAuthStatus) => void;
  mockAuthProbe(t, () => {
    probeCount += 1;
    return new Promise<ProviderAuthStatus>((resolve) => {
      release = resolve;
    });
  });

  const firstPromise = providerAuthService.getProviderAuthStatus('pi');
  const secondPromise = providerAuthService.getProviderAuthStatus('pi');

  assert.equal(probeCount, 1);

  release(authenticatedStatus);
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first, authenticatedStatus);
  assert.equal(second, authenticatedStatus);
  assert.equal(probeCount, 1);
});

test('getProviderAuthStatus re-probes after the TTL expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 30_000_000 });
  let probeCount = 0;
  mockAuthProbe(t, async () => {
    probeCount += 1;
    return authenticatedStatus;
  });

  const first = await providerAuthService.getProviderAuthStatus('pi');
  assert.equal(first, authenticatedStatus);
  assert.equal(probeCount, 1);

  t.mock.timers.tick(11_000);

  const second = await providerAuthService.getProviderAuthStatus('pi');
  assert.equal(second, authenticatedStatus);
  assert.equal(probeCount, 2);
});
