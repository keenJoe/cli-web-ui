import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createVisionBridgeConfigRepository,
  type VisionBridgeConfigRepository,
  type VisionBridgeStoredConfigShape,
} from '../vision-bridge-config.repository.js';

/**
 * Builds a repository rooted at a throwaway temp directory so tests never touch
 * the real `~/.cloudcli/vision-bridge` folder.
 */
function makeRepository(): { repo: VisionBridgeConfigRepository; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-config-'));
  const repo = createVisionBridgeConfigRepository({ root });
  return { repo, root };
}

/** Expected on-disk directory key for a user id. */
function userKey(userId: string | number): string {
  return createHash('sha256').update(String(userId), 'utf8').digest('hex');
}

const DEFAULT_CONFIG: VisionBridgeStoredConfigShape = {
  schemaVersion: 1,
  enabled: false,
  apiFormat: 'auto',
  maxImagesPerRun: 4,
  timeoutMs: 20000,
  concurrency: 2,
  maxTokens: 1024,
  promptTemplate: '请描述图片',
  sources: { userImages: true, toolImages: false },
};

test('first read returns null (no config on disk)', async () => {
  const { repo } = makeRepository();
  assert.equal(await repo.read('user-1'), null);
});

test('read returns the normalized config after save', async () => {
  const { repo } = makeRepository();
  const config: VisionBridgeStoredConfigShape = {
    ...DEFAULT_CONFIG,
    enabled: true,
    visionModel: { provider: 'openai', id: 'gpt-4o-mini' },
    promptTemplate: '请描述图片',
  };
  await repo.save('user-1', config);
  assert.deepEqual(await repo.read('user-1'), config);
});

test('config path is an absolute path rooted under the injected root', async () => {
  const { repo, root } = makeRepository();
  const configPath = repo.getConfigPath(42);
  assert.ok(path.isAbsolute(configPath), 'config path is absolute');
  assert.equal(
    configPath,
    path.join(root, 'users', userKey(42), 'config.json'),
    'path is <root>/users/<sha256>/config.json',
  );
});

test('different user ids map to different directories', async () => {
  const { repo, root } = makeRepository();
  await repo.save('alice', DEFAULT_CONFIG);
  await repo.save('bob', { ...DEFAULT_CONFIG, enabled: true, visionModel: { provider: 'p', id: 'm' } });

  assert.notEqual(userKey('alice'), userKey('bob'));
  assert.ok(fs.existsSync(path.join(root, 'users', userKey('alice'), 'config.json')));
  assert.ok(fs.existsSync(path.join(root, 'users', userKey('bob'), 'config.json')));
  assert.deepEqual(await repo.read('alice'), DEFAULT_CONFIG);
  assert.equal((await repo.read('bob'))?.enabled, true);
});

test('saving identical config is idempotent (same normalized bytes)', async () => {
  const { repo, root } = makeRepository();
  const config: VisionBridgeStoredConfigShape = {
    ...DEFAULT_CONFIG,
    enabled: true,
    visionModel: { provider: 'openai', id: 'gpt-4o-mini' },
    promptTemplate: '  hello\r\nworld  ',
  };
  await repo.save('u', config);
  const first = fs.readFileSync(path.join(root, 'users', userKey('u'), 'config.json'), 'utf8');
  await repo.save('u', config);
  const second = fs.readFileSync(path.join(root, 'users', userKey('u'), 'config.json'), 'utf8');
  assert.equal(first, second, 'file bytes must be stable');
});

test('write persists complete JSON (round-trips through JSON.parse)', async () => {
  const { repo, root } = makeRepository();
  const config: VisionBridgeStoredConfigShape = {
    schemaVersion: 1,
    enabled: true,
    visionModel: { provider: 'openai', id: 'gpt-4o-mini' },
    apiFormat: 'openai',
    baseUrl: 'https://example.com/v1',
    maxImagesPerRun: 6,
    timeoutMs: 15000,
    concurrency: 3,
    maxTokens: 2048,
    promptTemplate: 'desc',
    sources: { userImages: true, toolImages: true },
  };
  await repo.save('u', config);
  const raw = fs.readFileSync(path.join(root, 'users', userKey('u'), 'config.json'), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(parsed, config);
});

test('concurrent saves are serialized and the final file is complete JSON', async () => {
  const { repo, root } = makeRepository();
  const writes = Array.from({ length: 20 }, (_, i) => ({
    enabled: i % 2 === 0,
    maxImagesPerRun: 1 + (i % 8),
  })).map((patch, i) =>
    repo.save('u', {
      ...DEFAULT_CONFIG,
      enabled: patch.enabled,
      maxImagesPerRun: patch.maxImagesPerRun,
      visionModel: patch.enabled ? { provider: 'p', id: `m${i}` } : undefined,
    }),
  );

  await Promise.all(writes);

  const result = await repo.read('u');
  assert.ok(result, 'a complete config survives concurrent writes');
  assert.ok(Number.isInteger(result.maxImagesPerRun), 'integer field intact');
  assert.ok(result.maxImagesPerRun >= 1 && result.maxImagesPerRun <= 8);

  const raw = fs.readFileSync(path.join(root, 'users', userKey('u'), 'config.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'file is complete JSON after concurrent writes');
});

test('POSIX config file is 0600 and directory is 0700', { skip: process.platform === 'win32' }, async () => {
  const { repo, root } = makeRepository();
  await repo.save('u', DEFAULT_CONFIG);
  const dir = path.join(root, 'users', userKey('u'));
  const file = path.join(dir, 'config.json');

  const dirMode = fs.statSync(dir).mode & 0o777;
  const fileMode = fs.statSync(file).mode & 0o777;
  assert.equal(dirMode, 0o700, 'config directory must be 0700');
  assert.equal(fileMode, 0o600, 'config file must be 0600');
});

test('write failure preserves the old file and leaves no temp file', async () => {
  const { repo, root } = makeRepository();
  const dir = path.join(root, 'users', userKey('u'));
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG), { mode: 0o600 });

  // Make the directory read-only so the temp-file open/rename fails on POSIX.
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o400);
  }
  try {
    await assert.rejects(() => repo.save('u', { ...DEFAULT_CONFIG, maxImagesPerRun: 8 }));
  } finally {
    if (process.platform !== 'win32') {
      fs.chmodSync(dir, 0o700);
    }
  }

  const preserved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(preserved.maxImagesPerRun, DEFAULT_CONFIG.maxImagesPerRun, 'old config preserved');
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, 'no temp file left behind');
});

test('read returns null for corrupt JSON instead of throwing', async () => {
  const { repo, root } = makeRepository();
  const dir = path.join(root, 'users', userKey('u'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
  assert.equal(await repo.read('u'), null);
});
