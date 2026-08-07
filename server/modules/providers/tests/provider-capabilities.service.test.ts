import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderDefinition } from '@/shared/interfaces.js';

import { ProviderRegistry } from '../provider.registry.js';
import {
  createProviderCapabilitiesService,
  providerCapabilitiesService,
} from '../services/provider-capabilities.service.js';

test('T25: pi capabilities expose only plan/bypassPermissions with bypassPermissions default', () => {
  const caps = providerCapabilitiesService.getProviderCapabilities('pi');

  assert.equal(caps.provider, 'pi');
  assert.deepEqual(caps.permissionModes, ['plan', 'bypassPermissions']);
  assert.equal(caps.defaultPermissionMode, 'bypassPermissions');
  assert.equal(caps.supportsPermissionRequests, false);
});

test('pi capability facets match runtime support', () => {
  const caps = providerCapabilitiesService.getProviderCapabilities('pi');

  assert.equal(caps.supportsAbort, true);
  assert.equal(caps.supportsMcp, false);
  assert.equal(caps.supportsSkills, true);
  assert.equal(caps.supportsTokenUsage, true);
  assert.equal(caps.supportsEffort, true);
  assert.equal(caps.supportsImages, true);
  assert.equal(caps.supportsFiles, true);
  assert.equal(caps.mcp, null);
});

test('MCP capability metadata matches each registered provider facet', () => {
  assert.deepEqual(providerCapabilitiesService.getProviderCapabilities('cursor').mcp, {
    supportedScopes: ['user', 'project'],
    supportedTransports: ['stdio', 'http'],
    supportsWorkingDirectory: true,
    supportsEnvironmentVariableReferences: false,
  });
  assert.equal(providerCapabilitiesService.getProviderCapabilities('pi').mcp, null);
});

test('R1/R18: capabilities come from one registered definition without a service matrix', () => {
  const mcp = {
    supportedScopes: ['local'],
    supportedTransports: ['sse'],
    supportsWorkingDirectory: true,
    supportsEnvironmentVariableReferences: true,
    listServers: async () => ({ user: [], local: [], project: [] }),
    listServersForScope: async () => [],
    upsertServer: async (input) => ({
      provider: 'pi' as const,
      name: input.name,
      scope: input.scope ?? 'project',
      transport: input.transport,
    }),
    removeServer: async (input) => ({
      removed: false,
      provider: 'pi' as const,
      name: input.name,
      scope: input.scope ?? 'project',
    }),
  } satisfies NonNullable<ProviderDefinition['mcp']>;
  const definition: ProviderDefinition = {
    id: 'pi',
    descriptor: {
      permissionModes: ['plan'],
      defaultPermissionMode: 'plan',
      supportsImages: false,
      supportsFiles: true,
      supportsAbort: false,
      supportsPermissionRequests: true,
      supportsEffort: false,
    },
    runtime: {} as never,
    models: {} as never,
    auth: {} as never,
    sessions: {} as never,
    sessionSynchronizer: {} as never,
    mcp,
    usage: { getSessionTokenUsage: async () => ({}) } as never,
  };
  const service = createProviderCapabilitiesService(new ProviderRegistry([definition]));

  assert.deepEqual(service.getProviderCapabilities('pi'), {
    provider: 'pi',
    permissionModes: ['plan'],
    defaultPermissionMode: 'plan',
    supportsImages: false,
    supportsFiles: true,
    supportsAbort: false,
    supportsPermissionRequests: true,
    supportsEffort: false,
    supportsMcp: true,
    supportsSkills: false,
    supportsTokenUsage: true,
    mcp: {
      supportedScopes: ['local'],
      supportedTransports: ['sse'],
      supportsWorkingDirectory: true,
      supportsEnvironmentVariableReferences: true,
    },
  });
});
