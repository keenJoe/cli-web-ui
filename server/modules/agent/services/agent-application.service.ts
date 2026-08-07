import path from 'node:path';

import type { Octokit } from '@octokit/rest';
import type spawnProcess from 'cross-spawn';

import type {
  LLMProvider,
  ProviderRunOutcome,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

type AgentModelsGateway = Pick<
  typeof import('@/modules/providers/index.js').providerModelsService,
  'resolveRunModel'
>;

type AgentRuntimeGateway = Pick<
  typeof import('@/modules/providers/index.js').providerRuntimeService,
  'hasRuntime' | 'run' | 'abortRun'
>;

type AgentApplicationDependencies = {
  fileSystem: typeof import('node:fs/promises');
  crypto: typeof import('node:crypto');
  homeDirectory(): string;
  spawnProcess: typeof spawnProcess;
  githubTokens: { getActiveGithubToken(userId: number): string | null };
  projects: {
    createProjectPath(
      projectPath: string,
      customName: string | null,
    ): { outcome?: string; project?: unknown };
  };
  GithubClient: typeof import('@octokit/rest').Octokit;
  models: AgentModelsGateway;
  runtime: AgentRuntimeGateway;
};

type ResolveProjectInput = {
  githubUrl: string | null;
  projectPath: string | null;
  githubToken: string | null;
  userId: number;
};

type ResolveProjectResult = {
  projectPath: string;
  clonedProjectCreated: boolean;
};

type GitHubWorkflowInput = {
  createBranch: boolean;
  createPullRequest: boolean;
  githubUrl: string | null;
  githubToken: string | null;
  projectPath: string;
  branchName: string | null;
  message: string;
  userId: number;
};

type GitHubBranchInfo = {
  name: string;
  url: string;
};

type GitHubPullRequestInfo = {
  number: number;
  url: string;
};

type GitHubWorkflowResult = {
  branch: GitHubBranchInfo | null;
  pullRequest: GitHubPullRequestInfo | null;
};

type GitHubWorkflowError = {
  error: string;
};

type CompleteProviderRunInput = GitHubWorkflowInput & {
  providerStatus: ProviderRunOutcome['status'];
};

type CompleteProviderRunResult = {
  branch: GitHubBranchInfo | GitHubWorkflowError | null;
  pullRequest: GitHubPullRequestInfo | GitHubWorkflowError | null;
  error: string | null;
};

type CleanupOwnedProjectInput = {
  cleanup: boolean;
  githubUrl: string | null;
  clonedProjectCreated: boolean;
  projectPath: string | null;
  sessionId: string | null;
  deferred: boolean;
};

type RunProviderInput = {
  githubUrl: string | null;
  projectPath: string | null;
  githubToken: string | null;
  branchName: string | null;
  message: string;
  provider: string;
  model?: string;
  effort?: string;
  appSessionId: string;
  providerSessionId: string | null | undefined;
  userId: number;
  cleanup: boolean;
  createBranch: boolean;
  createPullRequest: boolean;
  writer: ProviderRuntimeWriter;
};

type RunProviderResult = {
  outcome: ProviderRunOutcome;
  projectPath: string;
  providerSessionId: string | null;
  branch: GitHubBranchInfo | GitHubWorkflowError | null;
  pullRequest: GitHubPullRequestInfo | GitHubWorkflowError | null;
  postRunError: string | null;
};

type GitHubRepository = {
  owner: string;
  repo: string;
};

type BranchValidation = {
  valid: boolean;
  error?: string;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Creates the Agent application workflow used by `agent.module.ts` for the
 * external Agent HTTP route. It owns checkout, generic provider dispatch,
 * Git/GitHub completion, and owned-checkout cleanup; transport translation stays outside.
 */
export function createAgentApplicationService(dependencies: AgentApplicationDependencies) {
  const fs = dependencies.fileSystem;
  const spawn = dependencies.spawnProcess;

  const trackProviderIdentity = (
    writer: ProviderRuntimeWriter,
    onProviderSessionId: (providerSessionId: string) => void,
  ): ProviderRuntimeWriter => ({
    userId: writer.userId,
    isWebSocketWriter: writer.isWebSocketWriter,
    isSSEStreamWriter: writer.isSSEStreamWriter,
    send: (data) => writer.send(data),
    setSessionId(providerSessionId) {
      onProviderSessionId(providerSessionId);
      writer.setSessionId?.(providerSessionId);
    },
  });

  const getGitRemoteUrl = async (repoPath: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const gitProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      gitProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
      gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
      gitProcess.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Failed to get git remote: ${stderr}`));
        }
      });
      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    });

  const normalizeGitHubUrl = (url: string): string => url
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\/$/, '')
    .toLowerCase();

  const parseGitHubUrl = (url: string): GitHubRepository => {
    const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match?.[1] || !match[2]) {
      throw new Error('Invalid GitHub URL format');
    }
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  };

  const autogenerateBranchName = (message: string): string => {
    let branchName = message
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!branchName) branchName = 'task';

    const timestamp = Date.now().toString(36).slice(-6);
    const suffix = `-${timestamp}`;
    const maxBaseLength = 50 - suffix.length;
    if (branchName.length > maxBaseLength) {
      branchName = branchName.substring(0, maxBaseLength);
    }
    branchName = branchName.replace(/-$/, '').replace(/^-+/, '');
    if (!branchName || branchName.startsWith('-')) branchName = 'task';
    branchName = `${branchName}${suffix}`;

    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)
      ? branchName
      : `branch-${timestamp}`;
  };

  const validateBranchName = (branchName: string): BranchValidation => {
    if (!branchName || branchName.trim() === '') {
      return { valid: false, error: 'Branch name cannot be empty' };
    }
    const invalidPatterns = [
      { pattern: /^\./, message: 'Branch name cannot start with a dot' },
      { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
      { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
      { pattern: /\s/, message: 'Branch name cannot contain spaces' },
      { pattern: /[~^:?*\[\\]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
      { pattern: /@{/, message: 'Branch name cannot contain @{' },
      { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
      { pattern: /^\//, message: 'Branch name cannot start with a slash' },
      { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
      { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' },
    ];
    for (const invalid of invalidPatterns) {
      if (invalid.pattern.test(branchName)) {
        return { valid: false, error: invalid.message };
      }
    }
    return /[\x00-\x1F\x7F]/.test(branchName)
      ? { valid: false, error: 'Branch name cannot contain control characters' }
      : { valid: true };
  };

  const getCommitMessages = async (
    projectPath: string,
    limit = 5,
  ): Promise<string[]> => new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    gitProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
    gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim().split('\n').filter((message) => message.length > 0));
      } else {
        reject(new Error(`Failed to get commit messages: ${stderr}`));
      }
    });
    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });

  const createGitHubPullRequest = async (
    client: InstanceType<typeof Octokit>,
    repository: GitHubRepository,
    branchName: string,
    title: string,
    body: string,
  ): Promise<GitHubPullRequestInfo> => {
    const { data: pullRequest } = await client.pulls.create({
      ...repository,
      title,
      head: branchName,
      base: 'main',
      body,
    });
    return { number: pullRequest.number, url: pullRequest.html_url };
  };

  const cloneGitHubRepository = async (
    githubUrl: string,
    githubToken: string | null,
    projectPath: string,
  ): Promise<{ path: string; created: boolean }> => {
    let parsedGithubUrl: URL;
    try {
      parsedGithubUrl = new URL(githubUrl);
    } catch {
      throw new Error('Invalid GitHub URL');
    }
    if (
      parsedGithubUrl.protocol !== 'https:'
      || parsedGithubUrl.hostname !== 'github.com'
      || parsedGithubUrl.username
      || parsedGithubUrl.password
    ) {
      throw new Error('Invalid GitHub URL');
    }

    const cloneUrl = parsedGithubUrl.toString();
    const cloneDirectory = path.resolve(projectPath);
    try {
      await fs.access(cloneDirectory);
      try {
        const existingUrl = await getGitRemoteUrl(cloneDirectory);
        if (normalizeGitHubUrl(existingUrl) === normalizeGitHubUrl(cloneUrl)) {
          return { path: cloneDirectory, created: false };
        }
        throw new Error(
          `Directory ${cloneDirectory} already exists with a different repository (${existingUrl}). Expected: ${githubUrl}`,
        );
      } catch {
        throw new Error(
          `Directory ${cloneDirectory} already exists but is not a valid git repository or git command failed`,
        );
      }
    } catch {
      // The legacy route proceeds to clone for any failed existing-checkout probe.
    }

    await fs.mkdir(path.dirname(cloneDirectory), { recursive: true });
    const environment = githubToken ? {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$CLOUDCLI_GITHUB_TOKEN"; }; f',
      CLOUDCLI_GITHUB_TOKEN: githubToken,
      GIT_TERMINAL_PROMPT: '0',
    } : process.env;

    await new Promise<void>((resolve, reject) => {
      const gitProcess = spawn(
        'git',
        ['clone', '--depth', '1', '--', cloneUrl, cloneDirectory],
        { stdio: ['pipe', 'pipe', 'pipe'], env: environment },
      );
      let stderr = '';
      gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
      gitProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Git clone failed: ${stderr}`));
      });
      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    });
    return { path: cloneDirectory, created: true };
  };

  const cleanupProject = async (
    projectPath: string,
    sessionId: string | null,
  ): Promise<void> => {
    try {
      const externalProjectsRoot = await fs.realpath(
        path.join(dependencies.homeDirectory(), '.claude', 'external-projects'),
      );
      const canonicalProjectPath = await fs.realpath(projectPath);
      const relativeProjectPath = path.relative(externalProjectsRoot, canonicalProjectPath);
      const isContained = relativeProjectPath !== ''
        && relativeProjectPath !== '..'
        && !relativeProjectPath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativeProjectPath);
      if (!isContained) {
        console.warn('Refusing to clean up non-external project:', projectPath);
        return;
      }

      await fs.rm(canonicalProjectPath, { recursive: true, force: true });
      if (sessionId) {
        try {
          await fs.rm(
            path.join(dependencies.homeDirectory(), '.claude', 'sessions', sessionId),
            { recursive: true, force: true },
          );
        } catch (error) {
          console.error('Failed to clean up session directory:', errorMessage(error));
        }
      }
    } catch (error) {
      console.error('Failed to clean up project:', error);
    }
  };

  return {
    /** Runs the transport-neutral Agent lifecycle for one validated request. */
    async runProvider(input: RunProviderInput): Promise<RunProviderResult> {
      if (!dependencies.runtime.hasRuntime(input.provider)) {
        throw new AppError(`Unsupported provider "${input.provider}".`, {
          code: 'UNSUPPORTED_PROVIDER',
          statusCode: 400,
        });
      }

      const provider = input.provider as LLMProvider;
      let finalProjectPath: string | null = null;
      let clonedProjectCreated = false;
      let observedProviderSessionId: string | null = null;
      const writer = trackProviderIdentity(input.writer, (providerSessionId) => {
        observedProviderSessionId = providerSessionId;
      });

      try {
        const project = await this.resolveProject({
          githubUrl: input.githubUrl,
          projectPath: input.projectPath,
          githubToken: input.githubToken,
          userId: input.userId,
        });
        finalProjectPath = project.projectPath;
        clonedProjectCreated = project.clonedProjectCreated;

        const runModel = await dependencies.models.resolveRunModel(provider, input.model);
        const providerRun = dependencies.runtime.run(provider, input.message, {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: input.appSessionId,
          providerSessionId: input.providerSessionId,
          model: runModel,
          effort: input.effort,
          permissionMode: 'bypassPermissions',
          skipPermissions: true,
        }, writer);

        // The coordinator registers synchronously inside runtime.run. Only then
        // expose the app session id so an immediate HTTP abort can find the run.
        writer.send({
          type: 'status',
          message: input.githubUrl
            ? 'Repository cloned and session started'
            : 'Session started',
          projectPath: finalProjectPath,
          sessionId: input.appSessionId,
        });

        const outcome = await providerRun;
        const providerSessionId = outcome.providerSessionId ?? observedProviderSessionId;
        const postRun = await this.completeProviderRun({
          providerStatus: outcome.status,
          createBranch: input.createBranch,
          createPullRequest: input.createPullRequest,
          githubUrl: input.githubUrl,
          githubToken: input.githubToken,
          projectPath: finalProjectPath,
          branchName: input.branchName,
          message: input.message,
          userId: input.userId,
        });

        this.cleanupOwnedProject({
          cleanup: input.cleanup,
          githubUrl: input.githubUrl,
          clonedProjectCreated,
          projectPath: finalProjectPath,
          sessionId: providerSessionId,
          deferred: true,
        });

        return {
          outcome,
          projectPath: finalProjectPath,
          providerSessionId,
          branch: postRun.branch,
          pullRequest: postRun.pullRequest,
          postRunError: postRun.error,
        };
      } catch (error) {
        this.cleanupOwnedProject({
          cleanup: input.cleanup,
          githubUrl: input.githubUrl,
          clonedProjectCreated,
          projectPath: finalProjectPath,
          sessionId: observedProviderSessionId,
          deferred: false,
        });
        throw error;
      }
    },

    /** Aborts the active provider run for an app-facing session id. */
    async abortRun(appSessionId: string): Promise<boolean> {
      return dependencies.runtime.abortRun(appSessionId);
    },

    async resolveProject(input: ResolveProjectInput): Promise<ResolveProjectResult> {
      let finalProjectPath: string;
      let clonedProjectCreated = false;
      if (input.githubUrl) {
        const token = input.githubToken
          || dependencies.githubTokens.getActiveGithubToken(input.userId);
        const targetPath = input.projectPath || path.join(
          dependencies.homeDirectory(),
          '.claude',
          'external-projects',
          dependencies.crypto
            .createHash('md5')
            .update(input.githubUrl + Date.now())
            .digest('hex'),
        );
        const checkout = await cloneGitHubRepository(
          input.githubUrl.trim(),
          token,
          targetPath,
        );
        finalProjectPath = checkout.path;
        clonedProjectCreated = checkout.created;
      } else {
        finalProjectPath = normalizeProjectPath(path.resolve(input.projectPath ?? ''));
        try {
          await fs.access(finalProjectPath);
        } catch {
          throw new Error(`Project path does not exist: ${finalProjectPath}`);
        }
      }

      finalProjectPath = normalizeProjectPath(finalProjectPath);
      const registration = dependencies.projects.createProjectPath(finalProjectPath, null);
      if (registration.outcome === 'active_conflict') {
        console.log('Project registration already exists for:', finalProjectPath);
      }
      return { projectPath: finalProjectPath, clonedProjectCreated };
    },

    async createGitHubArtifacts(input: GitHubWorkflowInput): Promise<GitHubWorkflowResult> {
      const token = input.githubToken
        || dependencies.githubTokens.getActiveGithubToken(input.userId);
      if (!token) {
        throw new Error(
          'GitHub token required for branch/PR creation. Please configure a GitHub token in settings.',
        );
      }
      const client = new dependencies.GithubClient({ auth: token });
      let repositoryUrl = input.githubUrl;
      if (!repositoryUrl) {
        try {
          repositoryUrl = await getGitRemoteUrl(input.projectPath);
          if (!repositoryUrl.includes('github.com')) {
            throw new Error('Project does not have a GitHub remote configured');
          }
        } catch (error) {
          throw new Error(`Failed to get GitHub remote URL: ${errorMessage(error)}`);
        }
      }
      const repository = parseGitHubUrl(repositoryUrl);
      const finalBranchName = input.branchName || autogenerateBranchName(input.message);
      if (input.branchName) {
        const validation = validateBranchName(finalBranchName);
        if (!validation.valid) {
          throw new Error(`Invalid branch name: ${validation.error}`);
        }
      }

      let branch: GitHubBranchInfo | null = null;
      if (input.createBranch) {
        const checkout = spawn('git', ['checkout', '-b', finalBranchName], {
          cwd: input.projectPath,
          stdio: 'pipe',
        });
        await new Promise<void>((resolve, reject) => {
          let stderr = '';
          checkout.stderr?.on('data', (data) => { stderr += data.toString(); });
          checkout.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else if (stderr.includes('already exists')) {
              const existing = spawn('git', ['checkout', finalBranchName], {
                cwd: input.projectPath,
                stdio: 'pipe',
              });
              existing.on('close', (existingCode) => {
                if (existingCode === 0) resolve();
                else reject(new Error(`Failed to checkout existing branch: ${stderr}`));
              });
            } else {
              reject(new Error(`Failed to create branch: ${stderr}`));
            }
          });
        });

        const push = spawn('git', ['push', '-u', 'origin', finalBranchName], {
          cwd: input.projectPath,
          stdio: 'pipe',
        });
        await new Promise<void>((resolve, reject) => {
          let stderr = '';
          push.stderr?.on('data', (data) => { stderr += data.toString(); });
          push.on('close', (code) => {
            if (
              code === 0
              || stderr.includes('already exists')
              || stderr.includes('up-to-date')
            ) {
              resolve();
            } else {
              reject(new Error(`Failed to push branch: ${stderr}`));
            }
          });
        });
        branch = {
          name: finalBranchName,
          url: `https://github.com/${repository.owner}/${repository.repo}/tree/${finalBranchName}`,
        };
      }

      let pullRequest: GitHubPullRequestInfo | null = null;
      if (input.createPullRequest) {
        const commitMessages = await getCommitMessages(input.projectPath, 5);
        const title = commitMessages[0] || input.message;
        let body = '## Changes\n\n';
        body += commitMessages.length > 0
          ? commitMessages.map((message) => `- ${message}`).join('\n')
          : `Agent task: ${input.message}`;
        body += '\n\n---\n*This pull request was automatically created by CloudCLI.ai Agent.*';
        pullRequest = await createGitHubPullRequest(
          client,
          repository,
          finalBranchName,
          title,
          body,
        );
      }
      return { branch, pullRequest };
    },

    /**
     * Runs optional GitHub side effects only after a successful provider run.
     *
     * The Agent route translates this transport-neutral result to SSE or JSON;
     * outcome gating and workflow error handling remain application concerns.
     */
    async completeProviderRun(
      input: CompleteProviderRunInput,
    ): Promise<CompleteProviderRunResult> {
      if (
        input.providerStatus !== 'completed'
        || (!input.createBranch && !input.createPullRequest)
      ) {
        return { branch: null, pullRequest: null, error: null };
      }

      try {
        const artifacts = await this.createGitHubArtifacts(input);
        return { ...artifacts, error: null };
      } catch (error) {
        const detail = errorMessage(error);
        return {
          branch: { error: detail },
          pullRequest: { error: detail },
          error: detail,
        };
      }
    },

    cleanupOwnedProject(input: CleanupOwnedProjectInput): void {
      if (
        !input.cleanup
        || !input.githubUrl
        || !input.clonedProjectCreated
        || !input.projectPath
      ) {
        return;
      }
      if (input.deferred) {
        setTimeout(() => {
          void cleanupProject(input.projectPath!, input.sessionId);
        }, 5_000);
      } else {
        void cleanupProject(input.projectPath, input.sessionId);
      }
    },
  };
}
