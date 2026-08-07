import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createProviderRuntimeService } from '@/modules/providers/index.js';
import type { IProviderRuntime, ProviderDefinition } from '@/shared/interfaces.js';
import type { LLMProvider, ProviderRunRequest } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createAgentRouter } from '../agent.routes.js';
import { createAgentApplicationService } from '../services/agent-application.service.js';

type AgentDependencies = Parameters<typeof createAgentRouter>[0];
type ApplicationDependencies = Parameters<typeof createAgentApplicationService>[0];
type AgentTestOverrides = Partial<AgentDependencies> & {
  models?: ApplicationDependencies['models'];
  runtime?: ApplicationDependencies['runtime'];
};

function createApplication(
  overrides: Partial<ApplicationDependencies> = {},
): ReturnType<typeof createAgentApplicationService> {
  return createAgentApplicationService({
    fileSystem: {
      access: async () => undefined,
      mkdir: async () => undefined,
      realpath: async (targetPath: string) => targetPath,
      rm: async () => undefined,
    } as unknown as ApplicationDependencies['fileSystem'],
    crypto: nodeCrypto,
    homeDirectory: () => '/home/test',
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      ApplicationDependencies['spawnProcess'],
    githubTokens: { getActiveGithubToken: () => null },
    projects: { createProjectPath: () => ({ outcome: 'created' }) },
    GithubClient: class {} as unknown as ApplicationDependencies['GithubClient'],
    models: {
      resolveRunModel: async (_provider, requestedModel) => requestedModel?.trim() || undefined,
    },
    runtime: {
      hasRuntime: () => true,
      async run() {
        throw new Error('Provider runtime should not be called');
      },
      abortRun: async () => false,
    },
    ...overrides,
  });
}

function createDependencies(
  overrides: AgentTestOverrides = {},
): AgentDependencies {
  const {
    application,
    models,
    runtime,
    ...routerOverrides
  } = overrides;
  const applicationOverrides: Partial<ApplicationDependencies> = {};
  if (models) applicationOverrides.models = models;
  if (runtime) applicationOverrides.runtime = runtime;

  return {
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    application: application ?? createApplication(applicationOverrides),
    ...routerOverrides,
  };
}

async function withAgentServer(
  dependencies: AgentDependencies,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Agent route delegates the generic run lifecycle to one application call', () => {
  const routeSource = readFileSync(new URL('../agent.routes.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(routeSource, /dependencies\.(?:models|runtime)\b/);
  assert.doesNotMatch(routeSource, /application\.resolveProject\s*\(/);
  assert.doesNotMatch(routeSource, /models\.resolveRunModel\s*\(/);
  assert.doesNotMatch(routeSource, /runtime\.run\s*\(/);
  assert.doesNotMatch(routeSource, /application\.completeProviderRun\s*\(/);
  assert.doesNotMatch(routeSource, /application\.cleanupOwnedProject\s*\(/);
  assert.equal(routeSource.match(/application\.runProvider\s*\(/g)?.length, 1);
});

test('Agent route rejects missing project input before invoking provider dependencies', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Inspect this project', stream: false }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Either githubUrl or projectPath is required');
  });
});

test('Agent route validates API keys through the injected repository', async () => {
  const receivedKeys: string[] = [];
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: {
      validateApiKey: (apiKey) => {
        receivedKeys.push(apiKey);
        return undefined;
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'invalid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run' }),
    });
    assert.equal(response.status, 401);
  });

  assert.deepEqual(receivedKeys, ['invalid-key']);
});

test('Agent abort route uses API-key authentication and delegates the app session id', async () => {
  const receivedKeys: string[] = [];
  const abortedSessions: string[] = [];
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: {
      validateApiKey: (apiKey) => {
        receivedKeys.push(apiKey);
        return apiKey === 'valid-key' ? { id: 1, username: 'test-user' } : undefined;
      },
    },
    runtime: {
      hasRuntime: () => true,
      async run() {
        throw new Error('run should not be called by the abort route');
      },
      async abortRun(appSessionId) {
        abortedSessions.push(appSessionId);
        return true;
      },
    },
  }), async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/api/agent/sessions/app-session-1/abort`, {
      method: 'POST',
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/api/agent/sessions/app-session-1/abort`, {
      method: 'POST',
      headers: { 'x-api-key': 'valid-key' },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { success: true, aborted: true });
  });

  assert.deepEqual(receivedKeys, ['valid-key']);
  assert.deepEqual(abortedSessions, ['app-session-1']);
});

test('Agent route rejects GitHub lookalike hosts before cloning', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com.evil.example/owner/repo',
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Invalid GitHub URL');
  });
});

test('GitHub cloning keeps credentials out of arguments and remote URL', async () => {
  const token = 'secret-token';
  let cloneArgs: readonly string[] = [];
  let cloneEnvironment: NodeJS.ProcessEnv | undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  await withAgentServer(createDependencies({
    application: createApplication({
      fileSystem: {
        access: async () => { throw new Error('missing'); },
        mkdir: async () => undefined,
      } as unknown as ApplicationDependencies['fileSystem'],
      githubTokens: { getActiveGithubToken: () => token },
      spawnProcess: ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        cloneArgs = args;
        cloneEnvironment = options.env;
        process.nextTick(() => child.emit('error', new Error('expected test failure')));
        return child;
      }) as unknown as ApplicationDependencies['spawnProcess'],
    }),
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        message: 'Run',
        stream: false,
      }),
    });
    assert.equal(response.status, 500);
  });

  assert.deepEqual(cloneArgs.slice(0, 5), [
    'clone', '--depth', '1', '--', 'https://github.com/owner/repo.git',
  ]);
  assert.equal(cloneArgs.length, 6);
  assert.equal(cloneArgs.join(' ').includes(token), false);
  assert.equal(cloneEnvironment?.CLOUDCLI_GITHUB_TOKEN, token);
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(cloneEnvironment?.GIT_CONFIG_VALUE_0, '');
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_1, 'credential.helper');
});

test('Agent route reuses a matching checkout without cloning or deleting it', async () => {
  const spawnedArguments: string[][] = [];
  const removedPaths: string[] = [];
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end('https://github.com/owner/repo.git\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as ApplicationDependencies['spawnProcess'];
  const models = {
    resolveRunModel: async () => undefined,
  } as unknown as ApplicationDependencies['models'];
  const runtime: ApplicationDependencies['runtime'] = {
    hasRuntime: () => true,
    async run() {
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
    abortRun: async () => false,
  };

  await withAgentServer(createDependencies({
    application: createApplication({
      fileSystem: {
        access: async () => undefined,
        realpath: async (targetPath: string) => targetPath,
        rm: async (targetPath: string) => { removedPaths.push(targetPath); },
      } as unknown as ApplicationDependencies['fileSystem'],
      spawnProcess,
      models,
      runtime,
    }),
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        projectPath: '/home/test/.claude/external-projects/existing',
        message: 'Run',
        stream: false,
        cleanup: true,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(spawnedArguments, [['config', '--get', 'remote.origin.url']]);
  assert.deepEqual(removedPaths, []);
});

test('Agent route preserves all five providers omitted-model inputs through generic dispatch', async () => {
  const expectedModels = new Map<LLMProvider, string | undefined>([
    ['claude', undefined],
    ['cursor', undefined],
    ['codex', 'codex-default-model'],
    ['opencode', 'opencode-default-model'],
    ['pi', 'pi-default-model'],
  ]);
  const calls: Array<{
    provider: LLMProvider;
    command: string;
    model: unknown;
    permissionMode: unknown;
    skipPermissions: unknown;
  }> = [];

  await withAgentServer(createDependencies({
    models: {
      resolveRunModel: async (provider: LLMProvider) => expectedModels.get(provider),
    } as unknown as ApplicationDependencies['models'],
    runtime: {
      hasRuntime: () => true,
      async run(provider, command, options) {
        calls.push({
          provider,
          command,
          model: options.model,
          permissionMode: options.permissionMode,
          skipPermissions: options.skipPermissions,
        });
        return { status: 'completed', providerSessionId: null, exitCode: 0 };
      },
      abortRun: async () => false,
    },
  }), async (baseUrl) => {
    for (const provider of expectedModels.keys()) {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: `/home/test/.claude/external-projects/${provider}-project`,
          message: `Run ${provider}`,
          provider,
          stream: false,
        }),
      });
      assert.equal(response.status, 200);
    }
  });

  assert.deepEqual(
    calls.map(({ provider, model, permissionMode, skipPermissions }) => ({
      provider,
      model,
      permissionMode,
      skipPermissions,
    })),
    [...expectedModels].map(
      ([provider, model]) => ({
        provider,
        model,
        permissionMode: 'bypassPermissions',
        skipPermissions: true,
      }),
    ),
  );
});

test('Agent route rejects an unknown runtime before resolving its project', async () => {
  let projectResolutions = 0;
  let runtimeRuns = 0;
  const runtime: ApplicationDependencies['runtime'] = {
    hasRuntime: () => false,
    async run() {
      runtimeRuns += 1;
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
    abortRun: async () => false,
  };
  const application = createApplication({ runtime });

  await withAgentServer(createDependencies({
    application: {
      ...application,
      async resolveProject(input) {
        projectResolutions += 1;
        return application.resolveProject(input);
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/unknown-provider',
        message: 'Run',
        provider: 'unknown-provider',
        stream: false,
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Unsupported provider "unknown-provider".',
    });
  });

  assert.equal(projectResolutions, 0);
  assert.equal(runtimeRuns, 0);
});

test('Agent route preserves application error status codes for JSON responses', async () => {
  const application = createApplication();

  await withAgentServer(createDependencies({
    application: {
      ...application,
      async runProvider() {
        throw new AppError('Run already active', {
          code: 'RUN_IN_PROGRESS',
          statusCode: 409,
        });
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/project',
        message: 'Run',
        stream: false,
      }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'Run already active',
    });
  });
});

test('Agent HTTP preserves app identity while resuming with the bound provider session id', async () => {
  type SessionRecord = {
    provider: LLMProvider;
    projectPath: string;
    providerSessionId: string | null;
  };

  const nativeSessionId = 'native-http-1';
  const requests: ProviderRunRequest[] = [];
  const sessions = new Map<string, SessionRecord>();
  const providerRuntime: IProviderRuntime = {
    async run(request, sink) {
      requests.push(request);
      if (request.providerSessionId === null) {
        sink.bindProviderSession({ providerSessionId: nativeSessionId });
      }
      return {
        status: 'completed',
        providerSessionId: request.providerSessionId ?? nativeSessionId,
        exitCode: 0,
      };
    },
  };
  const provider = {
    id: 'claude',
    descriptor: {
      permissionModes: ['default'],
      defaultPermissionMode: 'default',
      supportsImages: true,
      supportsFiles: true,
      supportsAbort: true,
      supportsPermissionRequests: false,
      supportsEffort: true,
    },
    runtime: providerRuntime,
    auth: {
      async getStatus() {
        return {
          provider: 'claude' as const,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage: () => [],
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as ProviderDefinition;
  const runtimeDependencies = {
    listProviders: () => [provider],
    resolveProvider: () => provider,
    resolveProviderSessionId(
      sessionId: string | null | undefined,
      selectedProvider: LLMProvider,
    ) {
      if (!sessionId) return null;
      const session = sessions.get(sessionId);
      if (session && session.provider !== selectedProvider) {
        throw new Error('session provider mismatch');
      }
      return session ? session.providerSessionId : sessionId;
    },
    async resolveResumeModel(
      _provider: 'claude',
      _sessionId: string | undefined,
      requestedModel?: string | null,
    ) {
      return requestedModel ?? undefined;
    },
    async getProviderModels() {
      return {
        models: { OPTIONS: [], DEFAULT: 'default-model' },
        cache: {
          updatedAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
          source: 'fresh' as const,
        },
      };
    },
    createRunId: () => `run-${requests.length + 1}`,
    sessionIdentity: {
      ensureAppSession(
        appSessionId: string,
        sessionProvider: LLMProvider,
        projectPath: string,
      ) {
        if (!sessions.has(appSessionId)) {
          sessions.set(appSessionId, {
            provider: sessionProvider,
            projectPath,
            providerSessionId: null,
          });
        }
      },
      assignProviderSessionId(
        appSessionId: string,
        providerSessionId: string,
        sessionProvider: LLMProvider,
      ) {
        const session = sessions.get(appSessionId);
        assert.ok(session, 'the app session must exist before native identity is bound');
        assert.equal(session.provider, sessionProvider);
        session.providerSessionId = providerSessionId;
      },
    },
  };
  const runtime = createProviderRuntimeService(runtimeDependencies);
  const models = {
    resolveRunModel: async () => undefined,
  } as unknown as ApplicationDependencies['models'];

  await withAgentServer(createDependencies({
    models,
    runtime,
  }), async (baseUrl) => {
    const firstResponse = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/http-mapping',
        message: 'Start fresh',
        provider: 'claude',
        stream: false,
      }),
    });
    const firstBody = await firstResponse.json() as {
      sessionId: string;
      providerSessionId: string;
    };
    assert.equal(firstResponse.status, 200);
    assert.notEqual(firstBody.sessionId, nativeSessionId);
    assert.equal(firstBody.providerSessionId, nativeSessionId);

    const secondResponse = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/http-mapping',
        message: 'Resume',
        provider: 'claude',
        sessionId: firstBody.sessionId,
        stream: false,
      }),
    });
    const secondBody = await secondResponse.json() as {
      sessionId: string;
      providerSessionId: string | null;
    };
    assert.equal(secondResponse.status, 200);
    assert.equal(secondBody.sessionId, firstBody.sessionId);
    assert.equal(secondBody.providerSessionId, nativeSessionId);
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.providerSessionId, null);
  assert.equal(requests[1]?.appSessionId, requests[0]?.appSessionId);
  assert.equal(requests[1]?.providerSessionId, nativeSessionId);
});

test('Agent HTTP rejects cross-provider resume before the selected runtime starts', async () => {
  type SessionRecord = {
    provider: LLMProvider;
    projectPath: string;
    providerSessionId: string | null;
  };

  const sessions = new Map<string, SessionRecord>();
  const runtimeCalls: ProviderRunRequest[] = [];
  const createProvider = (id: LLMProvider): ProviderDefinition => ({
    id,
    descriptor: {
      permissionModes: ['default'],
      defaultPermissionMode: 'default',
      supportsImages: true,
      supportsFiles: true,
      supportsAbort: true,
      supportsPermissionRequests: false,
      supportsEffort: true,
    },
    runtime: {
      async run(
        request: ProviderRunRequest,
        sink: Parameters<IProviderRuntime['run']>[1],
      ) {
        runtimeCalls.push(request);
        const providerSessionId = request.providerSessionId ?? `${id}-native`;
        if (request.providerSessionId === null) {
          sink.bindProviderSession({ providerSessionId });
        }
        return { status: 'completed', providerSessionId, exitCode: 0 };
      },
    },
    auth: {
      async getStatus() {
        return { provider: id, installed: true, authenticated: true, method: 'test', details: {} };
      },
    },
    sessions: {
      normalizeMessage: () => [],
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as ProviderDefinition);
  const providers = [createProvider('claude'), createProvider('cursor')];
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const runtime = createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) throw new Error(`Missing provider: ${providerName}`);
      return provider;
    },
    resolveProviderSessionId(
      sessionId: string | null | undefined,
      selectedProvider: LLMProvider,
    ) {
      if (!sessionId) return null;
      const session = sessions.get(sessionId);
      if (session && session.provider !== selectedProvider) {
        throw new Error('session provider mismatch');
      }
      return session?.providerSessionId ?? sessionId;
    },
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel ?? undefined;
    },
    async getProviderModels() {
      return {
        models: { OPTIONS: [], DEFAULT: 'default-model' },
        cache: {
          updatedAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
          source: 'fresh' as const,
        },
      };
    },
    createRunId: () => `run-${runtimeCalls.length + 1}`,
    sessionIdentity: {
      ensureAppSession(appSessionId, provider, projectPath) {
        const existing = sessions.get(appSessionId);
        if (existing && existing.provider !== provider) {
          throw new Error('session provider mismatch');
        }
        if (!existing) {
          sessions.set(appSessionId, { provider, projectPath, providerSessionId: null });
        }
      },
      assignProviderSessionId(appSessionId, providerSessionId, provider) {
        const session = sessions.get(appSessionId);
        assert.ok(session);
        assert.equal(session.provider, provider);
        session.providerSessionId = providerSessionId;
      },
    },
  });
  const models = {
    resolveRunModel: async () => undefined,
  } as unknown as ApplicationDependencies['models'];

  await withAgentServer(createDependencies({
    models,
    runtime,
  }), async (baseUrl) => {
    const firstResponse = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/provider-owner',
        message: 'Start with Claude',
        provider: 'claude',
        stream: false,
      }),
    });
    const firstBody = await firstResponse.json() as { sessionId: string };
    assert.equal(firstResponse.status, 200);

    const mismatchedResponse = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/provider-owner',
        message: 'Resume with Cursor',
        provider: 'cursor',
        sessionId: firstBody.sessionId,
        stream: false,
      }),
    });
    assert.notEqual(mismatchedResponse.status, 200);
  });

  assert.equal(runtimeCalls.length, 1);
  assert.equal(runtimeCalls[0]?.provider, 'claude');
});

test('Agent non-stream response reports a failed provider outcome as unsuccessful', async () => {
  await withAgentServer(createDependencies({
    models: {
      resolveRunModel: async () => undefined,
    } as unknown as ApplicationDependencies['models'],
    runtime: {
      hasRuntime: () => true,
      async run() {
        return {
          status: 'failed',
          providerSessionId: null,
          exitCode: 1,
          errorCode: 'IDENTITY_PERSISTENCE_FAILED',
        };
      },
      abortRun: async () => false,
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/failed-outcome',
        message: 'Run',
        provider: 'claude',
        stream: false,
      }),
    });
    const body = await response.json() as { success: boolean };

    assert.equal(body.success, false);
  });
});

test('Agent route never creates GitHub artifacts after an aborted provider outcome', async () => {
  let artifactCalls = 0;
  const models = {
    resolveRunModel: async () => undefined,
  } as unknown as ApplicationDependencies['models'];
  const runtime: ApplicationDependencies['runtime'] = {
    hasRuntime: () => true,
    async run() {
      return {
        status: 'aborted',
        providerSessionId: null,
        exitCode: 1,
      };
    },
    abortRun: async () => false,
  };
  const application = createApplication({ models, runtime });

  await withAgentServer(createDependencies({
    application: {
      ...application,
      async createGitHubArtifacts() {
        artifactCalls += 1;
        return {
          branch: { name: 'should-not-exist', url: 'https://example.test/should-not-exist' },
          pullRequest: null,
        };
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/aborted',
        message: 'Abort this run',
        provider: 'claude',
        stream: false,
        createBranch: true,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(artifactCalls, 0);
});

test('Agent route dispatches a runtime-registered provider without a whitelist', async () => {
  const calls: Array<{ provider: string; command: string; options: Record<string, unknown> }> = [];
  const genericRuntime = {
    hasRuntime(provider: string) {
      return provider === 'test-provider';
    },
    async run(
      provider: string,
      command: string,
      options: Record<string, unknown>,
    ) {
      calls.push({ provider, command, options });
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
    async abortRun() {
      return false;
    },
  };

  await withAgentServer(createDependencies({
    runtime: genericRuntime as unknown as ApplicationDependencies['runtime'],
    models: {
      resolveRunModel: async () => undefined,
    } as unknown as ApplicationDependencies['models'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/.claude/external-projects/test-provider',
        message: 'Run generic provider',
        provider: 'test-provider',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, 'test-provider');
  assert.equal(calls[0]?.command, 'Run generic provider');
  assert.equal(calls[0]?.options.permissionMode, 'bypassPermissions');
  assert.equal(calls[0]?.options.skipPermissions, true);
});
