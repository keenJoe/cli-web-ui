/**
 * Task 8.3 / T40 — success-path E2E against a REAL Pi 0.84.4 subprocess.
 *
 * Spawns the locked @earendil-works/pi-coding-agent@0.84.4 RPC child (via the
 * package's own cli.js, NOT the global /opt/homebrew/bin/pi which is 0.85.0)
 * with TWO `-e` extensions:
 *   1. the REAL production extension under test
 *      (server/modules/providers/list/pi/extensions/cloudcli-vision-bridge.ts)
 *   2. a controlled, credential-free fixture
 *      (scripts/e2e/vision-bridge-e2e-fixture-extension.ts) that registers a
 *      fake vision provider + a fake no-vision main provider via
 *      pi.registerProvider({ streamSimple }).
 *
 * Flow:
 *   host path attachment (~/.cloudcli/assets/<file>.png)
 *     -> readTrustedPiImages() (server/shared/image-attachments.ts) -> base64
 *     -> client.prompt(text, [imageContent])
 *     -> real child: context hook -> modelRegistry.complete(visionModel, {image})
 *        -> fake vision streamSimple records the image + returns observation
 *     -> context returns clone with image replaced by untrusted observation text
 *     -> fake main (no-vision) provider streamSimple records the transformed
 *        context (must have observation text, NO image) -> canned reply
 *     -> turn_end -> appendEntry persists the vision-bridge batch
 *     -> setStatus emits started/succeeded (realtime, carries clientMessageId)
 *
 * Asserts the T40 success chain:
 *  - secure adapter generated real base64 ImageContent (vision provider got it)
 *  - vision provider received the image
 *  - main provider received ONLY untrusted observation text, not the image,
 *    not a path descriptor, not a generic "[image omitted]" placeholder
 *  - original session user message still retains the image block
 *  - realtime setStatus events and the persisted custom entry share the SAME
 *    clientMessageId
 *
 * Produces an auditable JSON report at scripts/e2e/e2e-output/.
 * Run: node --import tsx scripts/e2e/vision-bridge-success-e2e.mts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpcClient } from '@earendil-works/pi-coding-agent';

import {
  getGlobalImageAssetsDir,
  readTrustedPiImages,
} from '../../server/shared/image-attachments.js';
import { parseVisionBridgeRunEvent } from '../../shared/vision-bridge.js';

const STATUS_KEY = 'cloudcli.vision-bridge.v1';
const CUSTOM_TYPE = 'cloudcli.vision-bridge.v1';
const HEALTH_COMMAND = 'cloudcli-vision-bridge-health-v1';
const VISION_PROVIDER = 'cloudcli-test-vision';
const VISION_MODEL = 'vision-model';
const MAIN_PROVIDER = 'cloudcli-test-main';
const MAIN_MODEL = 'main-model';
const CLIENT_MESSAGE_ID = 'msg-e2e-1';
const RUN_ID = 'e2e-run-1';
const APP_SESSION_ID = 'e2e-session-1';
const ASSET_FILENAME = 'vision-bridge-e2e-sample.png';

// A minimal valid 1x1 red PNG (real bytes, magic-number verified by the reader).
const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGA/fKpPgAAAABJRU5ErkJggg==';

function resolveCliJs(): string {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return path.join(path.dirname(entry), 'cli.js');
}

function resolveRepo(relative: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, relative);
}

/** Wait until a predicate over collected events holds, or the timeout elapses. */
function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        const value = await fn();
        if (value !== undefined) {
          clearInterval(timer);
          resolve(value);
          return;
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, intervalMs);
  });
}

interface AssertionResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface E2eReport {
  kind: 'real-subprocess-e2e';
  piPackageVersion: string;
  piCliPath: string;
  nodeVersion: string;
  realExtensionPath: string;
  fixtureExtensionPath: string;
  assetPath: string;
  contentHash: string;
  startedAt: string;
  endedAt: string;
  childStarted: boolean;
  healthCommandPresent: boolean;
  mainModelSet: boolean;
  turnSettled: boolean;
  assertions: AssertionResult[];
  visionReceived: unknown;
  mainReceived: unknown;
  realtimeEvents: unknown[];
  sessionCustomEntries: unknown[];
  sessionUserHasImage: boolean;
  failed: string[];
  passed: boolean;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const cliPath = resolveCliJs();
  const realExt = resolveRepo(
    '../../server/modules/providers/list/pi/extensions/cloudcli-vision-bridge.ts',
  );
  const fixtureExt = resolveRepo('vision-bridge-e2e-fixture-extension.ts');

  // Package version (not exported via package.json; read from the dist dir's parent).
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const pkgRaw = await readFile(path.join(path.dirname(entry), '..', 'package.json'), 'utf8');
  const piPackageVersion = (JSON.parse(pkgRaw) as { version: string }).version;

  // 1. Write a real PNG into the global upload store (~/.cloudcli/assets).
  const assetsDir = getGlobalImageAssetsDir();
  mkdirSync(assetsDir, { recursive: true });
  const assetPath = path.join(assetsDir, ASSET_FILENAME);
  await writeFile(assetPath, Buffer.from(SAMPLE_PNG_BASE64, 'base64'));
  const rawBytes = Buffer.from(SAMPLE_PNG_BASE64, 'base64');
  const contentHash = createHash('sha256').update(rawBytes).digest('hex');

  // 2. Vision-bridge config + correlation + record dir (temp).
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'vb-e2e-'));
  const configPath = path.join(workDir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      visionModel: { provider: VISION_PROVIDER, id: VISION_MODEL },
      maxImagesPerRun: 4,
      timeoutMs: 20000,
      concurrency: 2,
      maxTokens: 1024,
      promptTemplate: '请客观描述图片内容',
      sources: { userImages: true, toolImages: false },
    }),
  );
  const correlation = JSON.stringify({
    runId: RUN_ID,
    appSessionId: APP_SESSION_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    contentHashes: [contentHash],
  });
  const recordDir = path.join(workDir, 'records');

  // 3. Host-side secure adapter: path attachment -> base64 ImageContent.
  const { images, failures } = await readTrustedPiImages([{ path: assetPath }]);
  assert.equal(failures.length, 0, 'secure adapter must read the asset with no failures');
  assert.equal(images.length, 1, 'secure adapter must produce exactly one image');
  assert.equal(images[0].type, 'image');
  assert.equal(images[0].mimeType, 'image/png');
  assert.ok(images[0].data.length > 0, 'adapter must produce base64 data');
  // Confirm the adapter output round-trips to the original bytes (real base64,
  // not a path descriptor or placeholder).
  assert.deepEqual(
    Buffer.from(images[0].data, 'base64'),
    rawBytes,
    'adapter base64 must decode back to the original bytes',
  );

  // 4. Spawn the real 0.84.4 child with both extensions + env.
  const client = new RpcClient({
    cliPath,
    cwd: workDir,
    provider: MAIN_PROVIDER,
    model: MAIN_MODEL,
    args: ['--no-extensions', '-e', fixtureExt, '-e', realExt],
    env: {
      CLOUDCLI_VISION_BRIDGE_CONFIG_PATH: configPath,
      CLOUDCLI_VISION_BRIDGE_CORRELATION: correlation,
      CLOUDCLI_E2E_RECORD_DIR: recordDir,
      // Isolate pi auth/model state from the user's real ~/.pi.
      PI_CODING_AGENT_DIR: path.join(workDir, 'pi-dir'),
    },
  });

  const events: any[] = [];
  client.onEvent((e) => events.push(e));

  const assertions: AssertionResult[] = [];
  let childStarted = false;
  let healthCommandPresent = false;
  let mainModelSet = false;
  let turnSettled = false;
  let stderr = '';

  const check = (name: string, condition: boolean, detail: string): void => {
    assertions.push({ name, passed: condition, detail });
  };

  try {
    await client.start();
    childStarted = true;

    const commands = (await client.getCommands()) as Array<{ name?: string; source?: string }>;
    const health = commands.find((c) => c.name === HEALTH_COMMAND);
    healthCommandPresent = !!health && health.source === 'extension';
    check(
      'real bridge extension loaded (health command present)',
      healthCommandPresent,
      `source=${health?.source ?? 'none'}`,
    );

    // Ensure the no-vision main model is the active model (so the bridge does
    // NOT short-circuit on a native-vision model). setModel is authoritative
    // and runs after extension bind, so the registered providers are visible.
    try {
      const set = (await client.setModel(MAIN_PROVIDER, MAIN_MODEL)) as {
        provider: string;
        id: string;
      };
      mainModelSet = set.provider === MAIN_PROVIDER && set.id === MAIN_MODEL;
    } catch (e) {
      mainModelSet = false;
      check('setModel(main) succeeded', false, (e as Error).message);
    }
    check('no-vision main model is active', mainModelSet, `set=${mainModelSet}`);

    // 5. Send the path-attachment-derived image through the real RPC.
    await client.prompt('请根据图片内容回答：图里有什么？', images);

    // Wait for the turn to settle (assistant message + agent_settled).
    turnSettled =
      (await waitFor(
        () => (events.some((e) => e?.type === 'agent_settled') ? true : undefined),
        60_000,
      )) === true;
    check('turn settled (agent_settled)', turnSettled, `events=${events.length}`);

    // 6. Collect realtime vision-bridge setStatus events.
    const setStatusEvents = events.filter(
      (e) =>
        e?.type === 'extension_ui_request' &&
        e?.method === 'setStatus' &&
        e?.statusKey === STATUS_KEY,
    );
    const parsedEvents = setStatusEvents
      .map((e: any) => {
        try {
          const parsed = parseVisionBridgeRunEvent(JSON.parse(e.statusText));
          return parsed.ok ? parsed.value : null;
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const startedEvt = parsedEvents.find((e: any) => e.phase === 'started');
    const succeededEvt = parsedEvents.find((e: any) => e.phase === 'succeeded');
    check(
      'realtime: started + succeeded events present',
      !!startedEvt && !!succeededEvt,
      `phases=${parsedEvents.map((e: any) => e.phase).join(',')}`,
    );

    const rtClientMsg =
      (succeededEvt as any)?.source?.clientMessageId ??
      (startedEvt as any)?.source?.clientMessageId;
    const rtRunId = (succeededEvt as any)?.runId;
    const rtAppSession = (succeededEvt as any)?.appSessionId;
    check(
      'realtime event carries the clientMessageId',
      rtClientMsg === CLIENT_MESSAGE_ID,
      `clientMessageId=${rtClientMsg ?? 'none'}`,
    );
    check(
      'realtime event carries runId/appSessionId',
      rtRunId === RUN_ID && rtAppSession === APP_SESSION_ID,
      `runId=${rtRunId ?? 'none'} appSessionId=${rtAppSession ?? 'none'}`,
    );

    // 7. Records from the child (what each provider actually received).
    const visionReceived = (await readJsonSafe(path.join(recordDir, 'vision-received.json'))) as
      | {
          receivedImage?: { type?: string; mimeType?: string; dataLength?: number };
        }
      | null;
    const mainReceived = (await readJsonSafe(path.join(recordDir, 'main-received.json'))) as
      | {
          hasImageBlock?: boolean;
          context?: {
            messages?: Array<{
              role?: string;
              contentBlocks?: Array<{
                type?: string;
                hasData?: boolean;
                dataLength?: number;
                text?: string;
              }>;
            }>;
          };
        }
      | null;

    check(
      'vision provider received a real base64 image (secure adapter output)',
      visionReceived?.receivedImage?.type === 'image' &&
        visionReceived?.receivedImage?.mimeType === 'image/png' &&
        typeof visionReceived?.receivedImage?.dataLength === 'number' &&
        (visionReceived?.receivedImage?.dataLength ?? 0) > 0,
      `img=${JSON.stringify(visionReceived?.receivedImage)}`,
    );

    const mainBlocks = mainReceived?.context?.messages?.flatMap((m) => m.contentBlocks ?? []) ?? [];
    const hasImageBlock = mainBlocks.some((b) => b.type === 'image' && b.hasData);
    const hasObservation = mainBlocks.some(
      (b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes('视觉观察'),
    );
    // Pi's real image-downgrade placeholder (pi-ai transform-messages.js):
    //   "(image omitted: model does not support images)"
    //   "(tool image omitted: model does not support images)"
    // The bridge replaces the image block with the observation BEFORE this
    // downgrade runs, so the main provider must never see this placeholder.
    const OMITTED_RE = /image omitted/i;
    const hasOmittedPlaceholder = mainBlocks.some(
      (b) => b.type === 'text' && typeof b.text === 'string' && OMITTED_RE.test(b.text),
    );
    // A path descriptor would leak the asset path or a local_image reference
    // into the LLM context instead of base64 image bytes / observation text.
    const PATH_DESCRIPTOR_RE = /\.cloudcli\/assets|local_image|\.(png|jpe?g|gif|webp)\b/i;
    const hasPathDescriptor = mainBlocks.some(
      (b) =>
        b.type === 'text' &&
        typeof b.text === 'string' &&
        PATH_DESCRIPTOR_RE.test(b.text) &&
        !b.text.includes('视觉观察'),
    );
    check(
      'main provider received NO image block',
      !hasImageBlock,
      `hasImageBlock=${hasImageBlock}`,
    );
    check(
      'main provider received the untrusted observation text',
      hasObservation,
      `blocks=${JSON.stringify(mainBlocks.map((b) => ({ type: b.type, text: b.text?.slice(0, 60) })))}`,
    );
    check(
      'main provider did not receive a generic omitted placeholder instead of the observation',
      !hasOmittedPlaceholder,
      `hasOmittedPlaceholder=${hasOmittedPlaceholder}`,
    );
    check(
      'main provider did not receive a path descriptor instead of the image/observation',
      !hasPathDescriptor,
      `hasPathDescriptor=${hasPathDescriptor}`,
    );

    // 8. Session entries: original image retained + custom entry with same clientMessageId.
    const { entries } = (await client.getEntries()) as {
      entries: Array<Record<string, unknown>>;
    };
    const userEntry = entries.find(
      (e) =>
        e.type === 'message' &&
        (e.message as { role?: string })?.role === 'user',
    );
    const userContent = (userEntry?.message as { content?: unknown })?.content;
    const userHasImage =
      Array.isArray(userContent) &&
      userContent.some((b: any) => b?.type === 'image' && typeof b?.data === 'string');
    check(
      'original session user message retains the image block',
      userHasImage === true,
      `userHasImage=${userHasImage}`,
    );

    const customEntries = entries.filter(
      (e) => e.type === 'custom' && e.customType === CUSTOM_TYPE,
    );
    const batch = customEntries[0]?.data as
      | {
          items?: Array<{
            source?: { kind?: string; clientMessageId?: string };
            description?: string;
            errorCode?: string;
          }>;
        }
      | undefined;
    const histItem = batch?.items?.find((i: any) => i?.source?.kind === 'user');
    const histClientMsg = histItem?.source?.clientMessageId;
    const histHasDescription = typeof histItem?.description === 'string' && !!histItem?.description;
    check(
      'history custom entry persisted with the observation',
      customEntries.length === 1 && histHasDescription,
      `customCount=${customEntries.length} hasDesc=${histHasDescription}`,
    );
    check(
      'history custom entry carries the SAME clientMessageId as realtime',
      histClientMsg === CLIENT_MESSAGE_ID && histClientMsg === rtClientMsg,
      `history=${histClientMsg ?? 'none'} realtime=${rtClientMsg ?? 'none'}`,
    );

    // Report payload.
    const report: E2eReport = {
      kind: 'real-subprocess-e2e',
      piPackageVersion,
      piCliPath: cliPath,
      nodeVersion: process.version,
      realExtensionPath: realExt,
      fixtureExtensionPath: fixtureExt,
      assetPath,
      contentHash,
      startedAt,
      endedAt: new Date().toISOString(),
      childStarted,
      healthCommandPresent,
      mainModelSet,
      turnSettled,
      assertions,
      visionReceived,
      mainReceived: mainReceived
        ? { ...mainReceived, context: { messageCount: mainReceived.context?.messages?.length } }
        : null,
      realtimeEvents: parsedEvents.map((e: any) => ({
        phase: e.phase,
        source: e.source,
        runId: e.runId,
        appSessionId: e.appSessionId,
        imageIndex: e.imageIndex,
        cached: e.cached,
        errorCode: e.errorCode,
      })),
      sessionCustomEntries: customEntries.map((e) => ({
        customType: e.customType,
        itemCount: ((e.data as { items?: unknown[] })?.items ?? []).length,
      })),
      sessionUserHasImage: userHasImage === true,
      failed: [],
      passed: false,
    };
    report.failed = assertions.filter((a) => !a.passed).map((a) => a.name);
    report.passed = report.failed.length === 0;

    const outDir = resolveRepo('e2e-output');
    await mkdir(outDir, { recursive: true });
    const reportPath = path.join(outDir, 'vision-bridge-success-e2e.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`\nE2E REPORT: ${reportPath}\n`);

    if (!report.passed) {
      process.stderr.write(`E2E FAILED: ${report.failed.join(', ')}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    stderr = client.getStderr();
    process.stderr.write(`E2E ERROR: ${(error as Error).message}\n${stderr.slice(-2000)}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
    await rm(workDir, { recursive: true, force: true });
    // Remove the asset so repeated runs are clean.
    try {
      await rm(assetPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

async function readJsonSafe(p: string): Promise<unknown> {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

void main();
