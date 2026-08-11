import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PiProvider } from '@/modules/providers/list/pi/pi.provider.js';
import {
  ProviderRegistry,
  providerRegistry,
} from '@/modules/providers/provider.registry.js';
import type { ProviderDefinition } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

const createProviderDefinition = (
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition => ({
  id: 'pi',
  descriptor: {
    permissionModes: ['plan', 'bypassPermissions'],
    defaultPermissionMode: 'bypassPermissions',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsEffort: true,
  },
  runtime: {} as never,
  models: {} as never,
  auth: {} as never,
  sessions: {} as never,
  sessionSynchronizer: {} as never,
  ...overrides,
});

describe('providerRegistry', () => {
  it('throws UNSUPPORTED_PROVIDER for an unregistered provider', () => {
    try {
      providerRegistry.resolveProvider('does-not-exist');
      assert.fail('expected resolveProvider to throw');
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_PROVIDER');
      assert.equal(error.statusCode, 400);
    }
  });

  it('resolves pi to a PiProvider instance exposing only supported facets', () => {
    const resolved = providerRegistry.resolveProvider('pi');

    assert.ok(resolved instanceof PiProvider);
    assert.equal(resolved.id, 'pi');
    assert.ok(resolved.runtime);
    assert.ok(resolved.models);
    assert.equal(resolved.mcp, undefined);
    assert.ok(resolved.auth);
    assert.ok(resolved.skills);
    assert.ok(resolved.usage);
    assert.ok(resolved.sessions);
    assert.ok(resolved.sessionSynchronizer);
  });

  it('R2 distinguishes an unknown provider from a missing facet', () => {
    const registry = new ProviderRegistry([createProviderDefinition()]);

    assert.throws(
      () => registry.requireFacet('does-not-exist', 'mcp'),
      (error: unknown) => (
        error instanceof AppError
        && error.code === 'UNSUPPORTED_PROVIDER'
        && error.statusCode === 400
      ),
    );
    assert.throws(
      () => registry.requireFacet('pi', 'mcp'),
      (error: unknown) => (
        error instanceof AppError
        && error.code === 'PROVIDER_CAPABILITY_UNSUPPORTED'
        && error.statusCode === 400
      ),
    );
  });

  it('R4 rejects a descriptor whose default permission mode is not supported', () => {
    assert.throws(
      () => new ProviderRegistry([
        createProviderDefinition({
          descriptor: {
            permissionModes: ['plan'],
            defaultPermissionMode: 'bypassPermissions',
            supportsImages: true,
            supportsFiles: true,
            supportsAbort: true,
            supportsPermissionRequests: false,
            supportsEffort: true,
          },
        }),
      ]),
      (error: unknown) => (
        error instanceof AppError
        && error.code === 'PROVIDER_DESCRIPTOR_INVALID'
        && error.statusCode === 500
      ),
    );
  });
});
