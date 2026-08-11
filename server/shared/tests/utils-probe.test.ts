import assert from 'node:assert/strict';
import test from 'node:test';

import spawn from 'cross-spawn';

import { runCliVersionProbe } from '@/shared/utils.js';

test('runCliVersionProbe returns false when spawn fails with ENOENT', (t) => {
  t.mock.method(spawn, 'sync', () => ({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
  }));

  assert.equal(runCliVersionProbe('claude', ['--version']), false);
});

test('runCliVersionProbe returns false when the CLI exits with a non-zero status', (t) => {
  t.mock.method(spawn, 'sync', () => ({
    pid: 1,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 1,
    signal: null,
  }));

  assert.equal(runCliVersionProbe('codex', ['--version']), false);
});

test('runCliVersionProbe returns false when the probe times out and the process is signalled', (t) => {
  t.mock.method(spawn, 'sync', () => ({
    pid: 2,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: 'SIGTERM',
  }));

  assert.equal(runCliVersionProbe('cursor-agent', ['--version']), false);
});

test('runCliVersionProbe returns true for a healthy version probe', (t) => {
  t.mock.method(spawn, 'sync', () => ({
    pid: 3,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
  }));

  assert.equal(runCliVersionProbe('claude', ['--version']), true);
});
