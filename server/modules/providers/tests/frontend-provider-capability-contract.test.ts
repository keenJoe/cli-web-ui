import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('frontend provider capability contract suite passes', () => {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    TSX_TSCONFIG_PATH: 'tsconfig.json',
  };
  delete childEnvironment.NODE_TEST_CONTEXT;

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      'src/components/chat/provider-capability-readiness.test.tsx',
    ],
    {
      cwd: process.cwd(),
      env: childEnvironment,
      encoding: 'utf8',
    },
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
  const testCount = result.stdout.match(/tests (\d+)/)?.[1];
  assert.ok(testCount, 'Frontend provider contract output did not report a test count.');
  assert.ok(Number(testCount) >= 35, `Expected at least 35 frontend provider tests, received ${testCount}.`);
  assert.match(result.stdout, /fail 0/);
});
