/**
 * Release verification probe (OpenSpec add-vision-bridge task 8.2).
 *
 * Unlike the contract probe (scripts/probe-pi-vision-bridge.mts), which loads
 * a throwaway .ts fixture, this probe loads the *compiled* release artifact
 * (dist-server/.../cloudcli-vision-bridge.js) into a real Pi RPC subprocess and
 * confirms the health command `cloudcli-vision-bridge-health-v1` appears in
 * live getCommands(). This is the smoke check that the published bundle's
 * compiled extension + shared contract actually load together.
 *
 * Run with:
 *
 *   node --import tsx scripts/release/verify-pi-vision-extension.mts
 *
 * Produces an auditable JSON report at
 * scripts/probe-output/pi-vision-bridge-compiled-probe.json.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpcClient } from '@earendil-works/pi-coding-agent';

const HEALTH_COMMAND = 'cloudcli-vision-bridge-health-v1';

type ProbeResult = {
  packageVersion: string;
  nodeVersion: string;
  cliPath: string;
  compiledExtensionPath: string;
  sharedContractPath: string;
  started: boolean;
  checks: Record<string, unknown>;
  events: unknown[];
  createdAt: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function resolveCliJs(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return path.join(path.dirname(entry), 'cli.js');
}

async function resolvePackageVersion(): Promise<string> {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const packageJsonPath = path.join(path.dirname(entry), '..', 'package.json');
  const raw = await readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`pi package.json at ${packageJsonPath} has no version field`);
  }
  return pkg.version;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const outputDir = path.resolve(__dirname, '..', 'probe-output');
  await mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'pi-vision-bridge-compiled-probe.json');

  const packageVersion = await resolvePackageVersion();
  const nodeVersion = process.version;

  const cliPath = resolveCliJs();
  const compiledExtensionPath = path.join(
    repoRoot,
    'dist-server',
    'server',
    'modules',
    'providers',
    'list',
    'pi',
    'extensions',
    'cloudcli-vision-bridge.js',
  );
  const sharedContractPath = path.join(
    repoRoot,
    'dist-server',
    'shared',
    'vision-bridge.js',
  );

  const result: ProbeResult = {
    packageVersion,
    nodeVersion,
    cliPath,
    compiledExtensionPath,
    sharedContractPath,
    started: false,
    checks: {},
    events: [],
    createdAt: new Date().toISOString(),
  };

  const failed: string[] = [];

  // Pre-flight: compiled artifact + shared contract must exist on disk.
  const compiledExtensionExists = await exists(compiledExtensionPath);
  const sharedContractExists = await exists(sharedContractPath);
  result.checks.compiledExtensionExists = compiledExtensionExists;
  result.checks.sharedContractExists = sharedContractExists;
  if (!compiledExtensionExists) failed.push('compiledExtensionExists');
  if (!sharedContractExists) failed.push('sharedContractExists');

  if (compiledExtensionExists && sharedContractExists) {
    const client = new RpcClient({
      cliPath,
      cwd: process.cwd(),
      args: ['--no-extensions', '-e', compiledExtensionPath],
    });

    const events: unknown[] = [];
    client.onEvent((event) => {
      events.push(event);
    });

    try {
      await client.start();
      result.started = true;

      const state = await client.getState();
      const commands = (await client.getCommands()) as Array<{
        name?: string;
        source?: string;
      }>;

      const healthCommand = commands.find((c) => c.name === HEALTH_COMMAND);
      const extensionErrors = events.filter(
        (e) => (e as { type?: string })?.type === 'extension_error',
      );

      result.checks.stateReceived =
        typeof (state as { sessionId?: unknown })?.sessionId === 'string';
      result.checks.healthCommandPresent = Boolean(healthCommand);
      result.checks.healthCommandSource = healthCommand?.source ?? null;
      result.checks.healthCommandRegistersDespiteNoExtensions =
        Boolean(healthCommand) && extensionErrors.length === 0;
      result.checks.extensionLoadErrors = extensionErrors;
      result.checks.commandCount = commands.length;

      result.events = events.map((e) => {
        const obj = e as Record<string, unknown>;
        if (obj.type === 'extension_ui_request') {
          return obj;
        }
        return { type: obj.type };
      });

      if (result.checks.healthCommandPresent !== true) {
        failed.push('healthCommandPresent');
      }
      if (result.checks.healthCommandRegistersDespiteNoExtensions !== true) {
        failed.push('healthCommandRegistersDespiteNoExtensions');
      }
    } finally {
      await client.stop();
    }
  }

  result.checks.failed = failed;

  await writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(`\nPROBE REPORT: ${reportPath}\n`);

  if (failed.length > 0) {
    process.stderr.write(`PROBE FAILED: ${failed.join(', ')}\n`);
  }

  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
