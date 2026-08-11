import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchAnthropicModels,
  fetchOpenAICompatModels,
  normalizeModelsEndpoint,
} from '@/shared/utils.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const readHeaders = (init?: RequestInit): Record<string, string> => {
  if (!init?.headers) {
    return {};
  }

  if (init.headers instanceof Headers) {
    return Object.fromEntries(init.headers.entries());
  }

  return init.headers as Record<string, string>;
};

const abortedFetch = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });

test('normalizeModelsEndpoint appends /v1/models to a bare base url', () => {
  assert.equal(
    normalizeModelsEndpoint('https://api.example.com'),
    'https://api.example.com/v1/models',
  );
});

test('normalizeModelsEndpoint does not duplicate a trailing /v1', () => {
  assert.equal(
    normalizeModelsEndpoint('https://api.example.com/v1'),
    'https://api.example.com/v1/models',
  );
});

test('normalizeModelsEndpoint handles trailing slashes and a /v1/ suffix', () => {
  assert.equal(
    normalizeModelsEndpoint('https://api.example.com/'),
    'https://api.example.com/v1/models',
  );
  assert.equal(
    normalizeModelsEndpoint('https://api.example.com/v1/'),
    'https://api.example.com/v1/models',
  );
});

test('normalizeModelsEndpoint returns null for blank input', () => {
  assert.equal(normalizeModelsEndpoint(''), null);
  assert.equal(normalizeModelsEndpoint('   '), null);
});

test('fetchAnthropicModels returns parsed options and sends x-api-key plus anthropic-version', async (t) => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(200, {
      data: [
        { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
        { id: 'claude-haiku-4' },
        { id: 'claude-sonnet-5', display_name: '' },
      ],
    }),
  );

  const result = await fetchAnthropicModels('https://api.example.com', 'sk-test');

  assert.deepEqual(result, [
    { value: 'claude-opus-5', label: 'Claude Opus 5' },
    { value: 'claude-haiku-4', label: 'claude-haiku-4' },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
  ]);

  assert.equal(mockFetch.mock.calls.length, 1);
  const [url, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, 'https://api.example.com/v1/models');
  assert.deepEqual(readHeaders(init), {
    'x-api-key': 'sk-test',
    'anthropic-version': '2023-06-01',
  });
});

test('fetchAnthropicModels sends Authorization Bearer when an auth token is present', async (t) => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(200, { data: [{ id: 'claude-opus-5' }] }),
  );

  const result = await fetchAnthropicModels('https://api.example.com', 'sk-test', 'tok-test');

  assert.deepEqual(result, [{ value: 'claude-opus-5', label: 'claude-opus-5' }]);

  assert.equal(mockFetch.mock.calls.length, 1);
  const [url, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, 'https://api.example.com/v1/models');
  assert.deepEqual(readHeaders(init), {
    Authorization: 'Bearer tok-test',
    'anthropic-version': '2023-06-01',
  });
});

test('fetchAnthropicModels returns null when the request times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mockFetch = t.mock.method(globalThis, 'fetch', abortedFetch);

  const pending = fetchAnthropicModels('https://api.example.com', 'sk-test');
  await t.mock.timers.tick(8000);

  assert.equal(await pending, null);
  assert.equal(mockFetch.mock.calls.length, 1);
});

test('fetchAnthropicModels returns null on a non-2xx response', async (t) => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(401, { error: { type: 'authentication_error' } }),
  );

  const result = await fetchAnthropicModels('https://api.example.com', 'sk-test');

  assert.equal(result, null);
  assert.equal(mockFetch.mock.calls.length, 1);
});

test('fetchAnthropicModels returns null on bad JSON or a missing data array', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>oops</html>', { status: 200 }));
  assert.equal(await fetchAnthropicModels('https://api.example.com', 'sk-test'), null);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { models: [] }));
  assert.equal(await fetchAnthropicModels('https://api.example.com', 'sk-test'), null);
});

test('fetchOpenAICompatModels returns parsed options and sends a Bearer token', async (t) => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(200, {
      data: [
        { id: 'gpt-5.6', display_name: 'GPT-5.6' },
        { id: 'o3-pro' },
      ],
    }),
  );

  const result = await fetchOpenAICompatModels('https://aiapi.example.com', 'sk-bearer');

  assert.deepEqual(result, [
    { value: 'gpt-5.6', label: 'GPT-5.6' },
    { value: 'o3-pro', label: 'o3-pro' },
  ]);

  assert.equal(mockFetch.mock.calls.length, 1);
  const [url, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, 'https://aiapi.example.com/v1/models');
  assert.deepEqual(readHeaders(init), { Authorization: 'Bearer sk-bearer' });
});

test('fetchOpenAICompatModels returns null when the request times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mockFetch = t.mock.method(globalThis, 'fetch', abortedFetch);

  const pending = fetchOpenAICompatModels('https://aiapi.example.com', 'sk-bearer');
  await t.mock.timers.tick(8000);

  assert.equal(await pending, null);
  assert.equal(mockFetch.mock.calls.length, 1);
});

test('fetchOpenAICompatModels returns null on a non-2xx response', async (t) => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(500, { error: { message: 'boom' } }),
  );

  const result = await fetchOpenAICompatModels('https://aiapi.example.com', 'sk-bearer');

  assert.equal(result, null);
  assert.equal(mockFetch.mock.calls.length, 1);
});

test('fetchOpenAICompatModels returns null on bad JSON or a missing data array', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not json at all', { status: 200 }));
  assert.equal(await fetchOpenAICompatModels('https://aiapi.example.com', 'sk-bearer'), null);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { data: 'nope' }));
  assert.equal(await fetchOpenAICompatModels('https://aiapi.example.com', 'sk-bearer'), null);
});
