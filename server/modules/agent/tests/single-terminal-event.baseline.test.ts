import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { TextDecoder } from 'node:util';

import express from 'express';

import { createProviderRuntimeService } from '@/modules/providers/index.js';
import type { IProviderRuntime, ProviderDefinition } from '@/shared/interfaces.js';
import type { LLMProvider, ProviderRunRequest } from '@/shared/types.js';

import { createAgentRouter } from '../agent.routes.js';
import { createAgentApplicationService } from '../services/agent-application.service.js';

type AgentDependencies = Parameters<typeof createAgentRouter>[0];
type ApplicationDependencies = Parameters<typeof createAgentApplicationService>[0];

type SseReader = {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly decoder: TextDecoder;
  buffer: string;
};

function createProvider(runtime: IProviderRuntime): ProviderDefinition {
  const id: LLMProvider = 'claude';
  return {
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
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
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
}

function createApplication(
  runtime: ApplicationDependencies['runtime'],
  models: ApplicationDependencies['models'],
): ReturnType<typeof createAgentApplicationService> {
  return createAgentApplicationService({
    fileSystem: {
      access: async () => undefined,
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
    models,
    runtime,
  });
}

function createDependencies(runtime: IProviderRuntime): AgentDependencies {
  const provider = createProvider(runtime);
  const sessions = new Map<string, string | null>();
  const runtimeService = createProviderRuntimeService({
    listProviders: () => [provider],
    resolveProvider(providerName) {
      if (providerName !== provider.id) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: () => null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        models: { OPTIONS: [], DEFAULT: 'default-model' },
        cache: {
          updatedAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
          source: 'fresh',
        },
      };
    },
    createRunId: () => 'run-sse-test',
    sessionIdentity: {
      ensureAppSession(appSessionId) {
        if (!sessions.has(appSessionId)) sessions.set(appSessionId, null);
      },
      assignProviderSessionId(appSessionId, providerSessionId) {
        assert.equal(sessions.has(appSessionId), true);
        sessions.set(appSessionId, providerSessionId);
      },
    },
  });
  const models = {
    resolveRunModel: async () => undefined,
  } as unknown as ApplicationDependencies['models'];

  return {
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    application: createApplication(runtimeService, models),
  } as AgentDependencies;
}

async function listen(runtime: IProviderRuntime) {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(createDependencies(runtime)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/api/agent`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startStream(baseUrl: string): Promise<Response> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectPath: '/home/test/.claude/external-projects/baseline',
      message: 'Run',
      provider: 'claude',
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body, 'streaming response must expose a body');
  return response;
}

function createSseReader(response: Response): SseReader {
  assert.ok(response.body);
  return {
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: '',
  };
}

async function readNextFrame(stream: SseReader): Promise<Record<string, unknown> | null> {
  while (true) {
    const separator = stream.buffer.indexOf('\n\n');
    if (separator >= 0) {
      const chunk = stream.buffer.slice(0, separator);
      stream.buffer = stream.buffer.slice(separator + 2);
      const payload = chunk.replace(/^data: /, '').trim();
      if (payload) return JSON.parse(payload) as Record<string, unknown>;
      continue;
    }

    const result = await stream.reader.read();
    if (result.done) return null;
    stream.buffer += stream.decoder.decode(result.value, { stream: true });
  }
}

async function collectFrames(response: Response): Promise<Array<Record<string, unknown>>> {
  const stream = createSseReader(response);
  const frames: Array<Record<string, unknown>> = [];
  for (let frame = await readNextFrame(stream); frame; frame = await readNextFrame(stream)) {
    frames.push(frame);
  }
  return frames;
}

function terminalFrames(frames: Array<Record<string, unknown>>) {
  return frames.filter((frame) => frame.kind === 'complete');
}

test('SSE / R10: a normal typed run produces exactly one terminal and one done', async () => {
  const server = await listen({
    async run(request, sink) {
      sink.emit({
        id: 'event-normal',
        kind: 'stream_delta',
        provider: 'claude',
        sessionId: request.appSessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        content: 'hi',
      });
      return { status: 'completed', providerSessionId: null, exitCode: 0 };
    },
  });

  try {
    const frames = await collectFrames(await startStream(server.baseUrl));
    assert.equal(terminalFrames(frames).length, 1);
    assert.equal(terminalFrames(frames)[0]?.exitCode, 0);
    assert.equal(frames.filter((frame) => frame.type === 'done').length, 1);
  } finally {
    await server.close();
  }
});

test('SSE / R17: HTTP abort wins over late runtime output and outcome', async () => {
  let releaseRuntime!: () => void;
  const runtimeGate = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  let lateAttempted!: () => void;
  const lateAttempt = new Promise<void>((resolve) => {
    lateAttempted = resolve;
  });
  const receivedRequests: ProviderRunRequest[] = [];
  const receivedSignals: AbortSignal[] = [];
  const server = await listen({
    async run(request, sink, _context, signal) {
      receivedRequests.push(request);
      receivedSignals.push(signal);
      sink.bindProviderSession({ providerSessionId: 'native-sse-test' });
      await runtimeGate;
      sink.emit({
        id: 'late-event',
        kind: 'stream_delta',
        provider: 'claude',
        sessionId: request.appSessionId,
        timestamp: '2026-01-01T00:00:01.000Z',
        content: 'late',
      });
      lateAttempted();
      return { status: 'completed', providerSessionId: 'native-late', exitCode: 0 };
    },
  });
  let stream: SseReader | null = null;

  try {
    const response = await startStream(server.baseUrl);
    stream = createSseReader(response);
    const firstFrame = await readNextFrame(stream);
    const appSessionId = firstFrame?.sessionId;
    assert.equal(firstFrame?.type, 'status');
    assert.equal(typeof appSessionId, 'string');
    assert.ok((appSessionId as string).length > 0);

    const identityFrame = await readNextFrame(stream);
    assert.equal(identityFrame?.type, 'session-id');
    assert.equal(identityFrame?.sessionId, appSessionId);
    assert.equal(identityFrame?.providerSessionId, 'native-sse-test');

    const abortResponse = await fetch(
      `${server.baseUrl}/sessions/${encodeURIComponent(appSessionId as string)}/abort`,
      { method: 'POST' },
    );
    assert.equal(abortResponse.status, 200);
    assert.deepEqual(await abortResponse.json(), { success: true, aborted: true });

    releaseRuntime();
    await lateAttempt;
    assert.equal(receivedRequests[0]?.appSessionId, appSessionId);
    assert.equal(receivedRequests[0]?.providerSessionId, null);
    assert.equal(receivedSignals[0]?.aborted, true);

    const frames = [
      firstFrame as Record<string, unknown>,
      identityFrame as Record<string, unknown>,
    ];
    for (let frame = await readNextFrame(stream); frame; frame = await readNextFrame(stream)) {
      frames.push(frame);
    }
    const terminals = terminalFrames(frames);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.aborted, true);
    assert.equal(frames.some((frame) => frame.content === 'late'), false);
    assert.equal(frames.filter((frame) => frame.type === 'done').length, 1);
  } finally {
    releaseRuntime();
    await stream?.reader.cancel().catch(() => undefined);
    await server.close();
  }
});

test('SSE / R12: a typed runtime failure produces one failed terminal and one done', async () => {
  const server = await listen({
    async run() {
      throw new Error('provider process exited unexpectedly');
    },
  });

  try {
    const frames = await collectFrames(await startStream(server.baseUrl));
    const terminals = terminalFrames(frames);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.success, false);
    assert.equal(terminals[0]?.exitCode, 1);
    assert.equal(frames.filter((frame) => frame.type === 'done').length, 1);
  } finally {
    await server.close();
  }
});
