import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveVisionBridgeExtensionPath } from './pi-vision-extension-path.provider.js';

// The resolver only depends on `baseUrl`; tests pass a synthetic sibling-module
// URL inside a temp dir so they don't touch the real source tree.
function makeBaseUrl(dir: string): string {
  return pathToFileURL(path.join(dir, 'pi', 'pi-vision-extension-path.provider.js')).href;
}

test('resolver prefers the sibling .ts in the source (dev) layout', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vbp-dev-'));
  try {
    const piDir = path.join(root, 'pi');
    const extDir = path.join(piDir, 'extensions');
    mkdirSync(extDir, { recursive: true });
    const tsPath = path.join(extDir, 'cloudcli-vision-bridge.ts');
    const jsPath = path.join(extDir, 'cloudcli-vision-bridge.js');
    writeFileSync(tsPath, 'export default () => {};\n');
    writeFileSync(jsPath, 'module.exports = () => {};\n');

    assert.equal(resolveVisionBridgeExtensionPath(makeBaseUrl(root)), tsPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolver falls back to the sibling .js in the compiled (dist-server) layout', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vbp-prod-'));
  try {
    const piDir = path.join(root, 'pi');
    const extDir = path.join(piDir, 'extensions');
    mkdirSync(extDir, { recursive: true });
    const jsPath = path.join(extDir, 'cloudcli-vision-bridge.js');
    writeFileSync(jsPath, 'module.exports = () => {};\n');

    assert.equal(resolveVisionBridgeExtensionPath(makeBaseUrl(root)), jsPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolver returns null when neither extension file exists', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vbp-missing-'));
  try {
    // `pi/` exists but has no `extensions/` folder.
    mkdirSync(path.join(root, 'pi'), { recursive: true });
    assert.equal(resolveVisionBridgeExtensionPath(makeBaseUrl(root)), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});