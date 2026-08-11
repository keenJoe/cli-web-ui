import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import test from 'node:test';

import {
  createAgentApplicationService,
} from '../services/agent-application.service.js';

type ApplicationDependencies = Parameters<typeof createAgentApplicationService>[0];

function createDependencies(
  overrides: Partial<ApplicationDependencies> = {},
): ApplicationDependencies {
  return {
    fileSystem: {
      access: async () => undefined,
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
  };
}

test('application service resolves and registers an existing project path', async () => {
  const registeredPaths: string[] = [];
  const service = createAgentApplicationService(createDependencies({
    projects: {
      createProjectPath: (projectPath) => {
        registeredPaths.push(projectPath);
        return { outcome: 'created' };
      },
    },
  }));

  const result = await service.resolveProject({
    githubUrl: null,
    projectPath: '/workspace/project/../project',
    githubToken: null,
    userId: 1,
  });

  assert.deepEqual(result, {
    projectPath: '/workspace/project',
    clonedProjectCreated: false,
  });
  assert.deepEqual(registeredPaths, ['/workspace/project']);
});

test('application service rejects GitHub lookalike hosts before spawning git', async () => {
  let spawnCalled = false;
  const service = createAgentApplicationService(createDependencies({
    spawnProcess: (() => {
      spawnCalled = true;
      throw new Error('spawn should not run');
    }) as unknown as ApplicationDependencies['spawnProcess'],
  }));

  await assert.rejects(
    () => service.resolveProject({
      githubUrl: 'https://github.com.evil.example/owner/repo',
      projectPath: null,
      githubToken: null,
      userId: 1,
    }),
    /Invalid GitHub URL/,
  );
  assert.equal(spawnCalled, false);
});

test('application service owns post-run GitHub gating and error translation', async () => {
  const service = createAgentApplicationService(createDependencies());
  const workflowInput = {
    createBranch: true,
    createPullRequest: false,
    githubUrl: 'https://github.com/owner/repo',
    githubToken: null,
    projectPath: '/workspace/project',
    branchName: null,
    message: 'Run',
    userId: 1,
  };

  const aborted = await service.completeProviderRun({
    ...workflowInput,
    providerStatus: 'aborted',
  });
  assert.deepEqual(aborted, { branch: null, pullRequest: null, error: null });

  const failedWorkflow = await service.completeProviderRun({
    ...workflowInput,
    providerStatus: 'completed',
  });
  assert.deepEqual(failedWorkflow.branch, {
    error: 'GitHub token required for branch/PR creation. Please configure a GitHub token in settings.',
  });
  assert.deepEqual(failedWorkflow.pullRequest, failedWorkflow.branch);
  assert.match(failedWorkflow.error ?? '', /GitHub token required/);
});

test('application service owns ordered provider dispatch and deferred success cleanup', async () => {
  const events: string[] = [];
  const receivedOptions: Array<Record<string, unknown>> = [];
  const service = createAgentApplicationService(createDependencies({
    fileSystem: {
      access: async () => { events.push('project'); },
    } as unknown as ApplicationDependencies['fileSystem'],
    models: {
      async resolveRunModel(_provider, requestedModel) {
        events.push('model');
        return requestedModel ?? undefined;
      },
    },
    runtime: {
      hasRuntime: () => true,
      async run(_provider, _command, options, writer) {
        events.push('runtime');
        receivedOptions.push(options);
        writer.setSessionId?.('native-session-1');
        return { status: 'completed', providerSessionId: 'native-session-1', exitCode: 0 };
      },
      abortRun: async () => false,
    },
  }));
  const cleanupCalls: Array<Record<string, unknown>> = [];
  const workflow = {
    ...service,
    cleanupOwnedProject(input: Record<string, unknown>) {
      events.push('cleanup');
      cleanupCalls.push(input);
    },
  };
  const writerEvents: unknown[] = [];

  const result = await workflow.runProvider({
    githubUrl: null,
    projectPath: '/workspace/project',
    githubToken: null,
    branchName: null,
    message: 'Run provider',
    provider: 'claude',
    model: 'test-model',
    appSessionId: 'app-session-1',
    providerSessionId: null,
    userId: 1,
    cleanup: true,
    createBranch: false,
    createPullRequest: false,
    writer: {
      userId: 1,
      send(data) {
        const type = data && typeof data === 'object' && 'type' in data
          ? String(data.type)
          : 'event';
        events.push(type);
        writerEvents.push(data);
      },
      setSessionId(providerSessionId) {
        events.push(`identity:${providerSessionId}`);
      },
    },
  });

  assert.deepEqual(events, [
    'project',
    'model',
    'runtime',
    'identity:native-session-1',
    'status',
    'cleanup',
  ]);
  assert.equal(writerEvents.length, 1);
  assert.equal(receivedOptions[0]?.model, 'test-model');
  assert.equal(receivedOptions[0]?.permissionMode, 'bypassPermissions');
  assert.equal(receivedOptions[0]?.skipPermissions, true);
  assert.equal(result.providerSessionId, 'native-session-1');
  assert.deepEqual(cleanupCalls, [{
    cleanup: true,
    githubUrl: null,
    clonedProjectCreated: false,
    projectPath: '/workspace/project',
    sessionId: 'native-session-1',
    deferred: true,
  }]);
});

test('application service performs immediate cleanup after a failed provider run', async () => {
  const service = createAgentApplicationService(createDependencies({
    runtime: {
      hasRuntime: () => true,
      async run(_provider, _command, _options, writer) {
        writer.setSessionId?.('native-before-failure');
        throw new Error('provider failed');
      },
      abortRun: async () => false,
    },
  }));
  const cleanupCalls: Array<Record<string, unknown>> = [];
  const workflow = {
    ...service,
    async resolveProject() {
      return { projectPath: '/workspace/project', clonedProjectCreated: true };
    },
    cleanupOwnedProject(input: Record<string, unknown>) {
      cleanupCalls.push(input);
    },
  };

  await assert.rejects(
    () => workflow.runProvider({
      githubUrl: 'https://github.com/owner/repo',
      projectPath: '/workspace/project',
      githubToken: null,
      branchName: null,
      message: 'Run provider',
      provider: 'claude',
      appSessionId: 'app-session-1',
      providerSessionId: null,
      userId: 1,
      cleanup: true,
      createBranch: false,
      createPullRequest: false,
      writer: { send() {}, setSessionId() {} },
    }),
    /provider failed/,
  );
  assert.deepEqual(cleanupCalls, [{
    cleanup: true,
    githubUrl: 'https://github.com/owner/repo',
    clonedProjectCreated: true,
    projectPath: '/workspace/project',
    sessionId: 'native-before-failure',
    deferred: false,
  }]);
});
