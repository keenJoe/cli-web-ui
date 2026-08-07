import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';

import { Octokit } from '@octokit/rest';
import spawn from 'cross-spawn';

import {
  apiKeysDb,
  githubTokensDb,
  projectsDb,
  userDb,
} from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';

import { createAgentRouter } from './agent.routes.js';
import { createAgentApplicationService } from './services/agent-application.service.js';

type AgentRuntimeGateway = Parameters<typeof createAgentApplicationService>[0]['runtime'];

/**
 * Assembles the production Agent router from the same runtime service instance
 * used by WebSocket, keeping HTTP dispatch and abort on one coordinator.
 */
export function createAgentModule(runtime: AgentRuntimeGateway) {
  const application = createAgentApplicationService({
    fileSystem: fs,
    crypto,
    homeDirectory: os.homedir,
    spawnProcess: spawn,
    githubTokens: {
      getActiveGithubToken: (userId) => githubTokensDb.getActiveGithubToken(userId),
    },
    projects: {
      createProjectPath: (projectPath, customName) =>
        projectsDb.createProjectPath(projectPath, customName),
    },
    GithubClient: Octokit,
    models: providerModelsService,
    runtime,
  });

  return createAgentRouter({
    platformMode: process.env.VITE_IS_PLATFORM === 'true',
    users: {
      getFirstUser: () => userDb.getFirstUser(),
    },
    apiKeys: {
      validateApiKey: (apiKey) => apiKeysDb.validateApiKey(apiKey),
    },
    application,
  });
}
