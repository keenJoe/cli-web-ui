/**
 * Probe: pin the Pi 0.84.4 vision-bridge compatibility contract against a real
 * subprocess. Run with:
 *
 *   node --import tsx scripts/probe-pi-vision-bridge.mts
 *
 * It spawns the actual pi RPC child (via the package's own `RpcClient`) with
 * `--no-extensions -e <fixture>` and records, into an auditable JSON report, the
 * facts the vision bridge depends on. No production implementation files are
 * imported; only `@earendil-works/pi-coding-agent` and Node builtins.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpcClient } from '@earendil-works/pi-coding-agent';

const HEALTH_COMMAND = 'cloudcli-vision-bridge-health-v1';

type ProbeResult = {
  packageVersion: string;
  nodeVersion: string;
  cliPath: string;
  extensionPath: string;
  started: boolean;
  checks: Record<string, unknown>;
  events: unknown[];
  prompt: { attempted: boolean; outcome: string; error?: string };
  createdAt: string;
};

function resolveCliJs(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return path.join(path.dirname(entry), 'cli.js');
}

function resolveTypesDts(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return path.join(path.dirname(entry), 'core', 'extensions', 'types.d.ts');
}

/**
 * Read the installed pi package version from its package.json rather than a
 * hard-coded literal, so the auditable report always reflects the version the
 * probe actually ran against. package.json is not part of the package exports,
 * so resolve the main entry and walk up one directory.
 */
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

/** Static check of the shipped ExtensionAPI surface (d.ts), not the runtime. */
async function checkHookSurface(): Promise<Record<string, unknown>> {
  const dts = await readFile(resolveTypesDts(), 'utf8');
  const hasContext = /on\(event: "context"/.test(dts);
  const hasTurnEnd = /on\(event: "turn_end"/.test(dts);
  const hasBeforeProviderPayload = /before_provider_payload/.test(dts);
  const hasBeforeProviderRequest = /on\(event: "before_provider_request"/.test(dts);
  return {
    contextHookPresent: hasContext,
    turnEndHookPresent: hasTurnEnd,
    beforeProviderPayloadPresent: hasBeforeProviderPayload,
    beforeProviderRequestPresent: hasBeforeProviderRequest,
    // The bridge must NOT register a hook that does not exist in 0.84.4.
    contractOk: hasContext && hasTurnEnd && !hasBeforeProviderPayload,
  };
}

/** Wait until a predicate over collected events holds, or the timeout elapses. */
function waitFor(
  events: unknown[],
  predicate: (events: unknown[]) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate(events)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });
}

function firstEvent(events: unknown[], predicate: (event: any) => boolean): unknown {
  return events.find((event) => predicate(event as any));
}

/**
 * Stable, auditable output location (not $TMPDIR). The report is a reviewable
 * artifact, so it lives next to the probe script under scripts/probe-output/.
 */
function resolveOutputDir(): string {
  return path.resolve(import.meta.dirname, 'probe-output');
}

async function main(): Promise<void> {
  const outputDir = resolveOutputDir();
  await mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'pi-vision-bridge-probe.json');

  const packageVersion = await resolvePackageVersion();
  const nodeVersion = process.version;

  const cliPath = resolveCliJs();
  const extensionDir = await mkdtemp(path.join(outputDir, 'extension-'));
  const extensionPath = path.join(extensionDir, 'vision-bridge-probe-extension.ts');
  const fixturePath = fileURLToPath(
    new URL(
      '../server/modules/providers/list/pi/tests/fixtures/vision-bridge-probe-extension.ts',
      import.meta.url,
    ),
  );
  await writeFile(extensionPath, await readFile(fixturePath, 'utf8'));

  const result: ProbeResult = {
    packageVersion,
    nodeVersion,
    cliPath,
    extensionPath,
    started: false,
    checks: {},
    events: [],
    prompt: { attempted: false, outcome: 'not-attempted' },
    createdAt: new Date().toISOString(),
  };

  const client = new RpcClient({
    cliPath,
    cwd: process.cwd(),
    args: ['--no-extensions', '-e', extensionPath],
  });

  const events: unknown[] = [];
  client.onEvent((event) => {
    events.push(event);
  });

  try {
    await client.start();
    result.started = true;

    const state = await client.getState();
    const commands = (await client.getCommands()) as Array<{ name?: string; source?: string }>;
    const hookSurface = await checkHookSurface();

    const healthCommand = commands.find((c) => c.name === HEALTH_COMMAND);
    const extensionErrors = events.filter((e) => (e as any)?.type === 'extension_error');

    result.checks = {
      stateReceived: typeof (state as any)?.sessionId === 'string',
      healthCommandPresent: Boolean(healthCommand),
      healthCommandSource: healthCommand?.source ?? null,
      healthCommandRegistersDespiteNoExtensions:
        Boolean(healthCommand) && extensionErrors.length === 0,
      extensionLoadErrors: extensionErrors,
      ...hookSurface,
    };

    // Best-effort live turn: proves `context` firing -> setStatus emits
    // `extension_ui_request`, and `turn_end` -> appendEntry persists. Requires a
    // configured model; recorded as skipped rather than a failure when absent.
    const TINY_PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    try {
      result.prompt.attempted = true;
      await client.prompt('reply with the single word: ok', [
        { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
      ]);
      const sawExtensionUiRequest = await waitFor(
        events,
        (es) => es.some((e) => (e as any)?.type === 'extension_ui_request'),
        30_000,
      );
      const sawSettled = await waitFor(events, (es) => es.some((e) => (e as any)?.type === 'agent_settled'), 30_000);
      result.prompt.outcome = 'completed';
      result.checks.liveTurnExtensionUiRequestObserved = sawExtensionUiRequest;
      result.checks.liveTurnSettledObserved = sawSettled;
    } catch (error) {
      result.prompt.outcome = 'skipped';
      result.prompt.error = error instanceof Error ? error.message : String(error);
    }

    const setStatusRequests = events.filter(
      (e) => (e as any)?.type === 'extension_ui_request' && (e as any)?.method === 'setStatus',
    );
    result.checks.setStatusEmittedExtensionUiRequest = {
      count: setStatusRequests.length,
      sample: setStatusRequests[0] ?? null,
    };

    result.checks.contextHookFired = Boolean(
      firstEvent(
        events,
        (e) =>
          e?.type === 'extension_ui_request' &&
          e.method === 'setStatus' &&
          e.statusKey === 'cloudcli.vision-bridge.probe.context',
      ),
    );

    // E8 live-turn observations are part of the contract gate, not informational
    // side notes: if the model is configured and a turn was attempted, any missing
    // setStatus/appendEntry observation fails the probe. Absent a configured model
    // the turn is "skipped" and these flags are explicitly exempted from the gate.
    const liveTurnAttempted = result.prompt.attempted && result.prompt.outcome === 'completed';
    result.checks.liveTurnGated = liveTurnAttempted;

    // turn_end -> pi.appendEntry must persist a custom entry (E8). Read it from the
    // live session while the RPC client is still connected.
    if (liveTurnAttempted) {
      try {
        const { entries } = (await client.getEntries()) as {
          entries: Array<{ type?: string; customType?: string }>;
        };
        result.checks.entryAppended = entries.some(
          (e) => e.type === 'custom' && e.customType === 'cloudcli.vision-bridge.probe.turn-end',
        );
      } catch {
        result.checks.entryAppended = false;
      }
    } else {
      result.checks.entryAppended = null;
    }

    result.events = events.map((e) => {
      // Strip bulky/irrelevant payloads from the auditable report.
      const obj = e as Record<string, unknown>;
      if (obj.type === 'extension_ui_request') {
        return obj;
      }
      return { type: obj.type };
    });
  } finally {
    await client.stop();
  }

  // E8: when a live turn actually ran, its setStatus/appendEntry observations are
  // mandatory. Failure of any of them fails the probe with a non-zero exit code.
  const liveTurnFailed: string[] = [];
  if (result.prompt.attempted && result.prompt.outcome === 'completed') {
    const settleOk = result.checks.liveTurnSettledObserved === true;
    const uiOk = result.checks.liveTurnExtensionUiRequestObserved === true;
    const setStatus = result.checks.setStatusEmittedExtensionUiRequest as {
      count: number;
      sample: unknown;
    };
    const setStatusOk = typeof setStatus?.count === 'number' && setStatus.count > 0;
    const entryAppended = result.checks.entryAppended === true;
    if (!settleOk) liveTurnFailed.push('liveTurnSettledObserved');
    if (!uiOk) liveTurnFailed.push('liveTurnExtensionUiRequestObserved');
    if (!setStatusOk) liveTurnFailed.push('setStatusEmittedExtensionUiRequest');
    if (!entryAppended) liveTurnFailed.push('entryAppended');
  }
  result.checks.liveTurnFailed = liveTurnFailed;

  const failed: string[] = [];
  if (result.checks.contractOk !== true) failed.push('contractOk');
  if (result.checks.healthCommandPresent !== true) failed.push('healthCommandPresent');
  if (result.checks.healthCommandRegistersDespiteNoExtensions !== true) {
    failed.push('healthCommandRegistersDespiteNoExtensions');
  }
  for (const name of liveTurnFailed) failed.push(name);
  result.checks.failed = failed;

  await writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8');
  await rm(extensionDir, { recursive: true, force: true });

  // Emit the auditable report to stdout as well.
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