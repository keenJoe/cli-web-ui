/**
 * Resolves the on-disk absolute path of the vision-bridge extension for a live
 * Pi run (design.md D6, tasks 5.3).
 *
 * The extension ships as TypeScript under `server/modules/providers/list/pi/
 * extensions/cloudcli-vision-bridge.ts`. In development it is loaded directly
 * from that `.ts` source (tsx/loader runs it); in the compiled bundle
 * (`server/tsconfig.json` has `rootDir: ".."` and `outDir: "../dist-server"`)
 * the same file is emitted to `dist-server/server/modules/providers/list/pi/
 * extensions/cloudcli-vision-bridge.js`. This resolver computes the sibling
 * `.ts` (dev) and `.js` (compiled) candidates from `import.meta.url` and
 * returns the first one that exists as an absolute path, or `null` when
 * neither exists.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the vision-bridge extension path relative to a sibling module URL.
 *
 * `baseUrl` is the URL of a module in the `pi/` directory (this file by
 * default), so its directory contains the `extensions/` folder. The resolver
 * looks for `extensions/cloudcli-vision-bridge.ts` (dev) then
 * `extensions/cloudcli-vision-bridge.js` (compiled) and returns the first one
 * that exists as an absolute path.
 *
 * Never throws: a missing extension yields `null`, which the runtime treats as
 * "bridge unavailable" (and retries without it).
 */
export function resolveVisionBridgeExtensionPath(baseUrl = import.meta.url): string | null {
  // This module lives in the same `pi/` directory as the `extensions/` folder;
  // `baseUrl` is the URL of a sibling module (this file by default), so its
  // directory is the `pi/` dir and the extension is one level below it.
  const piDir = path.dirname(fileURLToPath(baseUrl));
  const extensionsDir = path.join(piDir, 'extensions');
  const candidates = [
    path.join(extensionsDir, 'cloudcli-vision-bridge.ts'),
    path.join(extensionsDir, 'cloudcli-vision-bridge.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}