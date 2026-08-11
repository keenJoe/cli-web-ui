import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { ProviderRuntimeWriter } from '@/shared/types.js';
import {
  AppError,
  generateMessageId,
  readObjectRecord,
} from '@/shared/utils.js';

import type { createAgentApplicationService } from './services/agent-application.service.js';

type AgentRouterDependencies = {
  platformMode: boolean;
  users: { getFirstUser(): unknown };
  apiKeys: { validateApiKey(apiKey: string): unknown };
  application: ReturnType<typeof createAgentApplicationService>;
};

type AgentUser = {
  id: number;
};

type AuthenticatedAgentRequest = Request & {
  user?: AgentUser;
};

type AgentRequestBody = Record<string, unknown>;

type AgentJsonResponse = {
  success: boolean;
  sessionId: string;
  providerSessionId: string | null;
  messages: unknown[];
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
  };
  projectPath: string;
  branch?: unknown;
  pullRequest?: unknown;
};

function readUser(value: unknown): AgentUser | null {
  const record = readObjectRecord(value);
  return record && typeof record.id === 'number' ? { id: record.id } : null;
}

function readRequestString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readApiKey(req: Request): string | null {
  const headerValue = req.headers['x-api-key'];
  const queryValue = req.query.apiKey;
  const candidate = Array.isArray(headerValue)
    ? headerValue[0]
    : (headerValue ?? (Array.isArray(queryValue) ? queryValue[0] : queryValue));
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function decodeMessageRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') {
    return readObjectRecord(value);
  }

  try {
    return readObjectRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Creates the external Agent HTTP transport consumed by `agent.module.ts` and
 * route tests. Business workflows are delegated to the Agent application service.
 */
export function createAgentRouter(dependencies: AgentRouterDependencies): express.Router {
  const router = express.Router();

  const validateExternalApiKey: RequestHandler = (
    req: AuthenticatedAgentRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (dependencies.platformMode) {
      try {
        const user = readUser(dependencies.users.getFirstUser());
        if (!user) {
          return res.status(500).json({ error: 'Platform mode: No user found in database' });
        }
        req.user = user;
        return next();
      } catch (error) {
        console.error('Platform mode error:', error);
        return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
      }
    }

    const apiKey = readApiKey(req);
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    const user = readUser(dependencies.apiKeys.validateApiKey(apiKey));
    if (!user) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }
    req.user = user;
    return next();
  };

  class SSEStreamWriter implements ProviderRuntimeWriter {
    readonly isSSEStreamWriter = true;
    private readonly res: Response;
    private readonly appSessionId: string;
    private providerSessionId: string | null = null;
    private headersInitialized = false;
    readonly userId: number;

    constructor(res: Response, userId: number, appSessionId: string) {
      this.res = res;
      this.appSessionId = appSessionId;
      this.userId = userId;
    }

    private ensureHeaders(): void {
      if (this.headersInitialized) return;
      this.res.setHeader('Content-Type', 'text/event-stream');
      this.res.setHeader('Cache-Control', 'no-cache');
      this.res.setHeader('Connection', 'keep-alive');
      this.res.setHeader('X-Accel-Buffering', 'no');
      this.headersInitialized = true;
    }

    send(data: unknown): void {
      if (!this.res.writableEnded) {
        this.ensureHeaders();
        this.res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    }

    end(): void {
      if (!this.res.writableEnded) {
        this.ensureHeaders();
        this.res.write('data: {"type":"done"}\n\n');
        this.res.end();
      }
    }

    setSessionId(providerSessionId: string): void {
      this.providerSessionId = providerSessionId;
      this.send({
        type: 'session-id',
        sessionId: this.appSessionId,
        providerSessionId,
      });
    }

    getSessionId(): string {
      return this.appSessionId;
    }

    getProviderSessionId(): string | null {
      return this.providerSessionId;
    }
  }

  class ResponseCollector implements ProviderRuntimeWriter {
    private readonly messages: unknown[] = [];
    private readonly appSessionId: string;
    private providerSessionId: string | null = null;
    readonly userId: number;

    constructor(userId: number, appSessionId: string) {
      this.appSessionId = appSessionId;
      this.userId = userId;
    }

    send(data: unknown): void {
      this.messages.push(data);
      const record = decodeMessageRecord(data);
      if (typeof record?.providerSessionId === 'string') {
        this.providerSessionId = record.providerSessionId;
      }
    }

    end(): void {}

    setSessionId(providerSessionId: string): void {
      this.providerSessionId = providerSessionId;
    }

    getSessionId(): string {
      return this.appSessionId;
    }

    getProviderSessionId(): string | null {
      return this.providerSessionId;
    }

    getAssistantMessages(): unknown[] {
      const assistantMessages: unknown[] = [];
      for (const message of this.messages) {
        const parsed = decodeMessageRecord(message);
        if (parsed?.type === 'status') continue;
        const data = readObjectRecord(parsed?.data);
        if (parsed?.type === 'claude-response' && data?.type === 'assistant') {
          assistantMessages.push(data);
        }
      }
      return assistantMessages;
    }

    getTotalTokens(): AgentJsonResponse['tokens'] {
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;
      for (const message of this.messages) {
        const record = decodeMessageRecord(message);
        const data = readObjectRecord(record?.data);
        const providerMessage = readObjectRecord(data?.message);
        const usage = record?.type === 'claude-response'
          ? readObjectRecord(providerMessage?.usage)
          : null;
        if (usage) {
          totalInput += readNumber(usage.input_tokens);
          totalOutput += readNumber(usage.output_tokens);
          totalCacheRead += readNumber(usage.cache_read_input_tokens);
          totalCacheCreation += readNumber(usage.cache_creation_input_tokens);
        }
      }
      const inputTokens = totalInput + totalCacheRead + totalCacheCreation;
      return {
        inputTokens,
        outputTokens: totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheCreationTokens: totalCacheCreation,
        totalTokens: inputTokens + totalOutput,
      };
    }
  }

  router.post('/sessions/:sessionId/abort', validateExternalApiKey, async (req, res) => {
    const rawSessionId = Array.isArray(req.params.sessionId)
      ? req.params.sessionId[0]
      : req.params.sessionId;
    const appSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    if (!appSessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    const aborted = await dependencies.application.abortRun(appSessionId);
    return res.json({ success: true, aborted });
  });

  router.post('/', validateExternalApiKey, async (request, res) => {
    const req = request as AuthenticatedAgentRequest;
    const body = readObjectRecord(req.body) as AgentRequestBody | null;
    const userId = req.user?.id;
    if (!body || typeof userId !== 'number') {
      return res.status(401).json({ error: 'Authenticated user required' });
    }

    const {
      githubUrl: githubUrlValue,
      projectPath: projectPathValue,
      message: messageValue,
      provider: providerValue = 'claude',
      model: modelValue,
      githubToken: githubTokenValue,
      branchName: branchNameValue,
      sessionId: sessionIdValue,
    } = body;
    const githubUrl = readRequestString(githubUrlValue);
    const projectPath = readRequestString(projectPathValue);
    const message = readRequestString(messageValue);
    const model = readRequestString(modelValue);
    const githubToken = readRequestString(githubTokenValue);
    const branchName = readRequestString(branchNameValue);
    const sessionId = readRequestString(sessionIdValue);
    const effort = typeof body.effort === 'string' && body.effort.trim()
      ? body.effort.trim()
      : undefined;
    const stream = body.stream === undefined
      ? true
      : body.stream === true || body.stream === 'true';
    const cleanup = body.cleanup === undefined
      ? true
      : body.cleanup === true || body.cleanup === 'true';
    const createBranch = branchName
      ? true
      : body.createBranch === true || body.createBranch === 'true';
    const createPullRequest = body.createPR === true || body.createPR === 'true';
    const requestedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const appSessionId = requestedSessionId || generateMessageId('session');
    const providerSessionId = requestedSessionId ? undefined : null;

    if (!githubUrl && !projectPath) {
      return res.status(400).json({ error: 'Either githubUrl or projectPath is required' });
    }
    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (typeof providerValue !== 'string') {
      return res.status(400).json({
        error: `Unsupported provider "${String(providerValue)}".`,
      });
    }
    const writer = stream
      ? new SSEStreamWriter(res, userId, appSessionId)
      : new ResponseCollector(userId, appSessionId);

    try {
      const run = await dependencies.application.runProvider({
        githubUrl: githubUrl || null,
        projectPath: projectPath || null,
        githubToken: githubToken || null,
        branchName: branchName || null,
        message: message.trim(),
        provider: providerValue,
        model,
        effort,
        appSessionId,
        providerSessionId,
        userId,
        createBranch,
        createPullRequest,
        cleanup,
        writer,
      });
      const branchInfo = run.branch;
      const pullRequestInfo = run.pullRequest;
      if (writer instanceof SSEStreamWriter && run.postRunError) {
        writer.send({ type: 'github-error', error: run.postRunError });
      } else if (writer instanceof SSEStreamWriter) {
        if (branchInfo) {
          writer.send({ type: 'github-branch', branch: branchInfo });
        }
        if (pullRequestInfo) {
          writer.send({ type: 'github-pr', pullRequest: pullRequestInfo });
        }
      }

      if (writer instanceof SSEStreamWriter) {
        writer.end();
      } else {
        const response: AgentJsonResponse = {
          success: run.outcome.status !== 'failed' && run.outcome.status !== 'aborted',
          sessionId: writer.getSessionId(),
          providerSessionId: run.providerSessionId,
          messages: writer.getAssistantMessages(),
          tokens: writer.getTotalTokens(),
          projectPath: run.projectPath,
        };
        if (branchInfo) response.branch = branchInfo;
        if (pullRequestInfo) response.pullRequest = pullRequestInfo;
        res.json(response);
      }

    } catch (error) {
      console.error('External session error:', error);
      const detail = error instanceof Error ? error.message : String(error);
      if (
        error instanceof AppError
        && error.code === 'UNSUPPORTED_PROVIDER'
        && !res.headersSent
      ) {
        return res.status(error.statusCode).json({ error: detail });
      }
      if (stream) {
        if (!res.writableEnded) {
          writer.send({ type: 'error', error: detail, message: `Failed: ${detail}` });
          writer.end();
        }
      } else if (!res.headersSent) {
        const statusCode = error instanceof AppError ? error.statusCode : 500;
        res.status(statusCode).json({ success: false, error: detail });
      }
    }
  });

  return router;
}
