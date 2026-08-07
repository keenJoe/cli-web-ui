import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ClaudeTokenUsageProvider } from '@/modules/providers/list/claude/claude-token-usage.provider.js';
import { CodexTokenUsageProvider } from '@/modules/providers/list/codex/codex-token-usage.provider.js';
import { OpenCodeTokenUsageProvider } from '@/modules/providers/list/opencode/opencode-token-usage.provider.js';
import { PiTokenUsageProvider } from '@/modules/providers/list/pi/pi-token-usage.provider.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError } from '@/shared/utils.js';

function createSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'app-session',
    provider: 'claude',
    provider_session_id: 'provider-session',
    project_path: null,
    jsonl_path: null,
    custom_name: null,
    model: null,
    isArchived: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('token usage lookup requires only the app-facing session id for Claude', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 30,
          },
        },
      }),
      '{incomplete',
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      requireUsageFacet: () => new ClaudeTokenUsageProvider({
        getContextWindow: () => '180000',
      }),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 155,
      total: 180_000,
      inputTokens: 125,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheTokens: 25,
      breakdown: { input: 125, output: 30 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage uses the latest token_count snapshot', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
            model_context_window: 250_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
      requireUsageFacet: () => new CodexTokenUsageProvider(),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 49,
      total: 250_000,
      inputTokens: 40,
      outputTokens: 9,
      breakdown: { input: 40, output: 9 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage resolves its provider-native id from the session row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      requireUsageFacet: () => new OpenCodeTokenUsageProvider({
        getDatabasePath: () => databasePath,
      }),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('R3: Cursor token usage rejects the missing usage facet', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'cursor' }),
  });

  await assert.rejects(
    () => service.getSessionTokenUsage('app-session'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'PROVIDER_CAPABILITY_UNSUPPORTED'
      && error.statusCode === 400
    ),
  );
});

test('R3: unregistered provider usage preserves the registry error without Claude fallback', async () => {
  const unknownProvider = 'future-provider';
  const unsupportedProviderError = new AppError(
    `Unsupported provider: ${unknownProvider}`,
    { code: 'UNSUPPORTED_PROVIDER', statusCode: 400 },
  );
  let claudeUsageAdapterCalls = 0;
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: unknownProvider }),
    requireUsageFacet: (provider) => {
      if (provider === 'claude') {
        return {
          async getSessionTokenUsage() {
            claudeUsageAdapterCalls += 1;
            throw new Error('Unknown providers must not invoke the Claude usage adapter.');
          },
        };
      }

      assert.equal(provider, unknownProvider);
      throw unsupportedProviderError;
    },
  });

  await assert.rejects(
    () => service.getSessionTokenUsage('app-session'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error, unsupportedProviderError);
      assert.equal(error.code, 'UNSUPPORTED_PROVIDER');
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  assert.equal(claudeUsageAdapterCalls, 0);
});

test('Pi token usage returns the last valid usage snapshot (T22)', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-pi-'));
  const sessionFilePath = path.join(tempDirectory, 'pi-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 's1',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          stopReason: 'end_turn',
          usage: {
            input: 100,
            output: 30,
            cacheRead: 20,
            cacheWrite: 5,
            totalTokens: 155,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'pi', jsonl_path: sessionFilePath }),
      requireUsageFacet: () => new PiTokenUsageProvider(),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 155,
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheTokens: 25,
      breakdown: { input: 100, output: 30 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Pi token usage reports no usage without falling back to .claude (T23)', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-pi-empty-'));
  const sessionFilePath = path.join(tempDirectory, 'pi-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 's1',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', stopReason: 'aborted' },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'pi', jsonl_path: sessionFilePath }),
      requireUsageFacet: () => new PiTokenUsageProvider(),
    });

    const result = await service.getSessionTokenUsage('app-session');

    assert.equal(result.used, 0);
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.deepEqual(result.breakdown, { input: 0, output: 0 });
    assert.equal(typeof result.message, 'string');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('token usage reports SESSION_NOT_FOUND for an unknown app session id', async () => {
  const service = createProviderTokenUsageService({ getSessionById: () => null });

  await assert.rejects(
    () => service.getSessionTokenUsage('missing-session'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'SESSION_NOT_FOUND'
      && error.statusCode === 404
    ),
  );
});
