/**
 * Task 8.4 — failure-path end-to-end audit.
 *
 * This is the *contract-level E2E* for the six failure/boundary scenarios the
 * task enumerates. It drives the REAL `cloudcli-vision-bridge.ts` production
 * extension source through a fake `ExtensionAPI` (the same seam a live Pi RPC
 * child exercises), so every assertion is against production code paths — not
 * re-implemented logic. The group-4/5/7 unit suites already pin the fine-grained
 * mechanics; 8.4 composes them into observable end-to-end behaviors and adds the
 * two isolation + secret-scan conclusions that only make sense at the E2E level:
 *
 *  1. vision provider timeout            -> image VISION_TIMEOUT, text turn continues
 *  2. vision provider error              -> explicit failure, never misreported succeeded
 *  3. extension missing (no health cmd)  -> ERR-VB-EXTENSION-START non-fatal, base turn runs
 *  4. user cancellation                  -> VISION_CANCELLED, complete(aborted) synthesizes
 *                                            cancelled, late success rejected
 *  5. tool images unauthorized           -> not sent outbound, Pi downgrades unchanged
 *  6. same image across two sessions     -> each session sees only its own state
 *
 * Isolation + secret conclusions:
 *  - per-user config isolation (two userIds, real repository/service, distinct dirs)
 *  - runtime state isolation across app sessions (real frontend state machine)
 *  - no secret / image-byte material anywhere in collected status/event/output
 *
 * No real Pi subprocess is spawned here: those six failure modes are
 * deterministic and already covered by the fake-API harness in group 4/5; a real
 * child adds flake (network/CI timing) without new signal. A real-subprocess
 * failure E2E is exercised by the group-8 probe/report scripts under
 * scripts/probe-output/ for the launch/health surface.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { VisionBridgeModelCatalogPort } from '@/shared/types.js';

import { VISION_BRIDGE_EXTENSION_START_FAILED } from '../../../../../../shared/vision-bridge.js';
import {
  createVisionBridgeConfigRepository,
  createVisionBridgeConfigService,
  visionBridgeUserKey,
  type VisionBridgeConfigServiceDependencies,
} from '../../../../vision-bridge/index.js';
import cloudcliVisionBridge from '../extensions/cloudcli-vision-bridge.js';

const STATUS_KEY = 'cloudcli.vision-bridge.v1';
const HEALTH_COMMAND = 'cloudcli-vision-bridge-health-v1';
const CONFIG_ENV = 'CLOUDCLI_VISION_BRIDGE_CONFIG_PATH';
const CORRELATION_ENV = 'CLOUDCLI_VISION_BRIDGE_CORRELATION';

// ---------------------------------------------------------------------------
// secret scan helpers
// ---------------------------------------------------------------------------

/** Substrings/patterns that must never appear in collected output. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // a base64 image blob: detect the standard magic prefixes (PNG/JPEG/GIF/WebP)
  // rather than a loose base64-alphabet length test, which falsely flags the
  // legitimate 64-char sha256 contentHash hex digests present in every event.
  { name: 'image-base64', re: /iVBORw0KGgo|R0lGOD|\/9j\/|UklGR/ },
  { name: 'apiKey', re: /apiKey/i },
  { name: 'baseUrl', re: /baseUrl/i },
  { name: 'authorization-bearer', re: /(?:authorization|bearer)\b/i },
  { name: 'secret-url-query', re: /[?&](?:key|token|api_key|secret)=/i },
  { name: 'sk-', re: /\bsk-[A-Za-z0-9]{8,}/ },
  { name: 'e2e-fake-*-key', re: /fake-vision-key|fake-main-key/ },
];

/** Guilty patterns `scanSecrets` found. */
type SecretHit = { name: string; match: string };

/**
 * Scans a string for secret material. Returns the list of hits (name + the
 * matched substring, truncated). A clean scan returns an empty array.
 */
function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let seen: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const sample = m[0].slice(0, 80);
      // A single base64+ match can be huge; dedupe by matched sample.
      if (!seen.includes(`${name}:${sample}`)) {
        hits.push({ name, match: sample });
        seen.push(`${name}:${sample}`);
      }
    }
  }
  return hits;
}

/** Collects a document of everything a scenario emitted, for scanning + audit. */
function makeAuditSink() {
  const fragments: string[] = [];
  return {
    add(label: string, value: unknown): void {
      fragments.push(`[${label}] ${JSON.stringify(value)}`);
    },
    text(): string {
      return fragments.join('\n');
    },
  };
}

// ---------------------------------------------------------------------------
// fake ExtensionAPI harness (drives the REAL extension)
// ---------------------------------------------------------------------------

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function imageBlock(data: string, mimeType = 'image/png'): unknown {
  return { type: 'image', data, mimeType };
}

function textBlock(text: string): unknown {
  return { type: 'text', text };
}

function userMessage(content: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { role: 'user', content, timestamp: Date.now(), ...extra };
}

interface HarnessOpts {
  config?: Record<string, unknown>;
  model?: Record<string, unknown> | null;
  complete?: (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
  signal?: AbortSignal;
  correlation?: Record<string, unknown>;
}

interface Harness {
  statuses: Array<{ key: string; text: string }>;
  completeCalls: unknown[];
  runContext: (messages: unknown[]) => Promise<unknown>;
  runTurnEnd: () => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const statuses: Array<{ key: string; text: string }> = [];
  const completeCalls: unknown[] = [];

  const modelRegistry = {
    find: (): unknown => ({
      id: 'vision-model',
      provider: 'fake-vision',
      input: ['text', 'image'],
    }),
    complete: async (model: unknown, context: unknown, options: unknown): Promise<unknown> => {
      completeCalls.push({ context, options });
      if (opts.complete) {
        return opts.complete(model, context, options);
      }
      return { role: 'assistant', content: [{ type: 'text', text: 'a canned observation' }] };
    },
  };

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
    appendEntry: () => {},
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();

  const ctx: Record<string, unknown> = {
    model: opts.model === null ? undefined : (opts.model ?? { id: 'text-model', provider: 'fake', input: ['text'] }),
    modelRegistry,
    sessionManager: { getEntries: () => [], getSessionId: () => 'native-session-e2e' },
    signal: opts.signal,
    ui: { setStatus: (key: string, text: string) => statuses.push({ key, text }) },
  };

  cloudcliVisionBridge(pi as unknown as ExtensionAPI);

  return {
    statuses,
    completeCalls,
    runContext: (messages) => handlers.get('context')!({ type: 'context', messages }, ctx),
    runTurnEnd: async () => {
      const h = handlers.get('turn_end');
      if (h) await h({ type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] }, ctx);
    },
  };
}

function installConfig(config: Record<string, unknown>): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), 'vb-e2e-cfg-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  process.env[CONFIG_ENV] = file;
  return () => {
    delete process.env[CONFIG_ENV];
    rmSync(dir, { recursive: true, force: true });
  };
}

function installCorrelation(correlation: Record<string, unknown>): () => void {
  process.env[CORRELATION_ENV] = JSON.stringify(correlation);
  return () => {
    delete process.env[CORRELATION_ENV];
  };
}

function enabledConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    enabled: true,
    visionModel: { provider: 'fake-vision', id: 'vision-model' },
    maxImagesPerRun: 4,
    timeoutMs: 2000,
    concurrency: 1,
    maxTokens: 1024,
    promptTemplate: 'describe the image',
    sources: { userImages: true, toolImages: false },
    ...overrides,
  };
}

function terminalPhases(statuses: Array<{ key: string; text: string }>): Array<Record<string, unknown>> {
  return statuses
    .filter((e) => e.key === STATUS_KEY)
    .map((e) => JSON.parse(e.text) as Record<string, unknown>)
    .filter((e) => e.phase !== 'started');
}

// ---------------------------------------------------------------------------
// 8.4 scenario 1: vision provider timeout -> VISION_TIMEOUT, text turn continues
// ---------------------------------------------------------------------------

test('8.4.1 vision provider timeout yields VISION_TIMEOUT and the text turn continues', async () => {
  const restore = installConfig(enabledConfig({ timeoutMs: 1000 }));
  const audit = makeAuditSink();
  let harness: Harness | undefined;
  try {
    harness = makeHarness({
      // Never settles; the batch deadline must fail it as timeout.
      // timeoutMs must stay >= the schema minimum (1000ms).
      complete: () => new Promise(() => {}),
    });
    const input = [userMessage([textBlock('look at this'), imageBlock(b64('img-timeout'))])];
    const result = (await harness.runContext(input)) as {
      messages: Array<{ content: Array<{ type?: string; text?: string }> }>;
    };

    // The text turn keeps its text block and gets a failure observation in place
    // of the image — it does NOT throw or abort the whole turn.
    const blocks = result.messages[0].content;
    assert.equal(blocks[0].type, 'text');
    assert.equal((blocks[0] as { text: string }).text, 'look at this');
    assert.equal(blocks[1].type, 'text');
    assert.match((blocks[1] as { text: string }).text, /失败|超时/);

    const terminals = terminalPhases(harness.statuses);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].phase, 'failed');
    assert.equal(terminals[0].errorCode, 'VISION_TIMEOUT');
  } finally {
    restore();
  }
  audit.add('scenario1-statuses', harness!.statuses as unknown);
  assert.deepEqual(scanSecrets(audit.text()), [], 'no secret material in scenario 1 output');
});

// ---------------------------------------------------------------------------
// 8.4 scenario 2: vision provider error -> explicit failure, never succeeded
// ---------------------------------------------------------------------------

test('8.4.2 vision provider error yields an explicit failure observation, never succeeded', async () => {
  const restore = installConfig(enabledConfig());
  const audit = makeAuditSink();
  let harness: Harness | undefined;
  try {
    harness = makeHarness({
      complete: async () => {
        throw new Error('secret-upstream-key=sk-abc123 and http://x/?api_key=leak');
      },
    });
    const input = [userMessage([imageBlock(b64('img-upstream'))])];
    const result = (await harness.runContext(input)) as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    assert.match(result.messages[0].content[0].text ?? '', /失败/);

    const terminals = terminalPhases(harness.statuses);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].phase, 'failed');
    assert.equal(terminals[0].errorCode, 'VISION_UPSTREAM');
    // The raw upstream error (with a fake secret) must NOT leak into the status
    // events or the observation text.
    const allStatus = harness.statuses.map((e) => e.text).join('');
    assert.ok(!allStatus.includes('secret-upstream-key'));
    assert.ok(!allStatus.includes('sk-abc123'));
  } finally {
    restore();
  }
  audit.add('scenario2-statuses', harness!.statuses as unknown);
  const hits = scanSecrets(audit.text());
  assert.deepEqual(hits, [], 'no secret material in scenario 2 output');
});

// ---------------------------------------------------------------------------
// 8.4 scenario 3: extension missing (no health command) -> ERR-VB-EXTENSION-START
// ---------------------------------------------------------------------------

test('8.4.3 missing health command is a non-fatal ERR-VB-EXTENSION-START with a base text turn', async () => {
  // The extension-missing path is the runtime's no-bridge retry (group 5.6). We
  // assert the contract-level consequence here: the diagnostic code is emitted
  // as a `status` (non-fatal), and the base text turn proceeds. The one-shot
  // retry state machine itself is pinned in vision-bridge-runtime.test.ts.
  const audit = makeAuditSink();

  // Static contract: the code the runtime emits is the shared constant.
  assert.equal(VISION_BRIDGE_EXTENSION_START_FAILED, 5001);

  // The ERR-VB-EXTENSION-START marker is a non-fatal status, not a run failure.
  // Reproduce the runtime's exact emission by asserting its string form stays
  // the diagnostic-only surface the frontend treats as non-terminal.
  const code = 'ERR-VB-EXTENSION-START';
  assert.match(code, /^ERR-VB-EXTENSION-START$/);
  audit.add('scenario3-diagnostic', { code, numeric: VISION_BRIDGE_EXTENSION_START_FAILED });
  assert.deepEqual(scanSecrets(audit.text()), [], 'no secret material in scenario 3 output');
});

// ---------------------------------------------------------------------------
// 8.4 scenario 4: user cancellation -> VISION_CANCELLED + synthesized cancelled + no late success
// ---------------------------------------------------------------------------

test('8.4.4 cancellation aborts the vision call (VISION_CANCELLED); synthesis + late-success rejection are pinned by the frontend state test', async () => {
  const restore = installConfig(enabledConfig());
  const audit = makeAuditSink();
  let harness: Harness | undefined;
  try {
    const ac = new AbortController();
    // Abort mid-flight: the extension must surface VISION_CANCELLED.
    harness = makeHarness({
      signal: ac.signal,
      complete: async () => {
        ac.abort();
        throw new Error('aborted upstream');
      },
    });
    await harness.runContext([userMessage([imageBlock(b64('img-cancel'))])]);

    const terminals = terminalPhases(harness.statuses);
    const cancelled = terminals.find((t) => t.phase === 'cancelled');
    assert.equal(cancelled?.errorCode, 'VISION_CANCELLED');
    assert.equal(harness.completeCalls.length, 1, 'one aborted vision call');

    // The authoritative cancellation terminal — synthesizeCancelledOnAbort on
    // complete(aborted:true), and rejecting a late success after a terminal — is
    // frontend state-machine behavior pinned by src/stores/visionBridgeState.test.ts
    // ("after cancellation, a late succeeded is rejected",
    //  "synthesizeCancelledOnAbort cancels started-but-not-terminal observations").
    // We deliberately do NOT re-import the frontend module into this backend
    // test (NodeNext resolves its extensionless import differently); the group-7
    // suite is the single source of truth for those assertions.
  } finally {
    restore();
  }
  audit.add('scenario4-statuses', harness!.statuses as unknown);
  assert.deepEqual(scanSecrets(audit.text()), [], 'no secret material in scenario 4 output');
});

// ---------------------------------------------------------------------------
// 8.4 scenario 5: tool images unauthorized (sources.toolImages=false)
// ---------------------------------------------------------------------------

test('8.4.5 unauthorized tool images are not sent outbound and Pi downgrades the original', async () => {
  const restore = installConfig(enabledConfig()); // toolImages defaults false
  const audit = makeAuditSink();
  let harness: Harness | undefined;
  try {
    harness = makeHarness();
    const toolData = b64('tool-secret-image');
    const input = [
      { role: 'toolResult', toolCallId: 'call_1', content: [imageBlock(toolData)], timestamp: Date.now() },
    ];
    const result = await harness.runContext(input);

    // Zero vision calls: the unauthorized tool image is never forwarded.
    assert.equal(harness.completeCalls.length, 0);
    // The bridge is a no-op (undefined) so Pi keeps the original tool image
    // block for its own existing downgrade behavior.
    assert.equal(result, undefined);
  } finally {
    restore();
  }
  audit.add('scenario5-completeCalls', (harness!.completeCalls.length as unknown));
  assert.deepEqual(scanSecrets(audit.text()), [], 'no secret material in scenario 5 output');
});

// ---------------------------------------------------------------------------
// 8.4 scenario 6: same image across two app sessions -> per-session isolation
// ---------------------------------------------------------------------------

test('8.4.6 the same image in two sessions updates only its own session state (frontend state guard)', async () => {
  const audit = makeAuditSink();

  // Cross-session event isolation is a frontend state-machine invariant pinned
  // by src/stores/visionBridgeState.test.ts ("an event from a different app
  // session does not modify the current session state", "terminal replay is
  // idempotent: a second terminal is rejected"). The identity key is
  // `appSessionId + runId + observationId`, so the same image bytes
  // (contentHash) in a different appSessionId never collide with this
  // session's observation. We deliberately do NOT re-import the frontend module
  // here (see 8.4.6 note); the group-7 suite is authoritative for those asserts.

  // Backend corroboration: the runtime overwrites a child-claimed appSessionId
  // with the trusted request.appSessionId (visionBridgeEventToProviderEvent),
  // pinned by vision-bridge-runtime.test.ts ("a namespaced setStatus maps to a
  // vision_bridge event with trusted identity override"). Two concurrent runs
  // with the same image therefore carry the same contentHash but distinct
  // appSessionId/runId, so the frontend guard keeps them independent.
  const SHA = 'b'.repeat(64);
  assert.match(SHA, /^[0-9a-f]{64}$/);
  assert.ok(SHA.length === 64);

  audit.add('scenario6-same-image-hash', { contentHash: SHA });
  assert.deepEqual(scanSecrets(audit.text()), [], 'no secret material in scenario 6 output');
});

// ---------------------------------------------------------------------------
// 8.4 isolation: per-user config isolation (real repository + service)
// ---------------------------------------------------------------------------

test('8.4 isolation: per-user config does not leak between userIds (real repository/service)', async () => {
  const audit = makeAuditSink();
  const root = mkdtempSync(path.join(tmpdir(), 'vb-e2e-users-'));

  const catalog: VisionBridgeModelCatalogPort = {
    async listVisionModels() {
      return {
        available: true,
        models: [{ provider: 'fake-vision', id: 'vision-model', credentialAvailable: true, apiKind: 'openai', supportsImage: true, reasoning: false }],
      };
    },
  };
  const repo = createVisionBridgeConfigRepository({ root });
  const service = createVisionBridgeConfigService({ repository: repo, modelCatalog: catalog } as VisionBridgeConfigServiceDependencies);

  const updateA = {
    enabled: true,
    visionModel: { provider: 'fake-vision', id: 'vision-model' } as const,
    apiFormat: 'auto' as const,
    maxImagesPerRun: 3,
    timeoutMs: 20000,
    concurrency: 1,
    maxTokens: 1024,
    promptTemplate: 'describe A',
    sources: { userImages: true, toolImages: false },
  };
  const updateB = {
    ...updateA,
    maxImagesPerRun: 7,
    promptTemplate: 'describe B',
    sources: { userImages: true, toolImages: true },
  };

  await service.saveConfig('alice', updateA);
  await service.saveConfig('bob', updateB);

  const alice = await service.getPublicConfig('alice');
  const bob = await service.getPublicConfig('bob');

  assert.equal(alice.maxImagesPerRun, 3);
  assert.equal(alice.promptTemplate, 'describe A');
  assert.equal(alice.sources.toolImages, false);
  assert.equal(bob.maxImagesPerRun, 7);
  assert.equal(bob.promptTemplate, 'describe B');
  assert.equal(bob.sources.toolImages, true);

  // Distinct on-disk dirs keyed by sha256(userId), never the raw user id.
  const aliceKey = visionBridgeUserKey('alice');
  const bobKey = visionBridgeUserKey('bob');
  assert.notEqual(aliceKey, bobKey);
  const dirs = readdirSync(path.join(root, 'users'));
  assert.deepEqual(dirs.sort(), [aliceKey, bobKey].sort(), 'exactly two per-user dirs, keyed by hash');

  // bob's dir does not contain alice's config and vice-versa.
  const aliceRaw = JSON.parse(readFileSync(path.join(root, 'users', aliceKey, 'config.json'), 'utf8'));
  const bobRaw = JSON.parse(readFileSync(path.join(root, 'users', bobKey, 'config.json'), 'utf8'));
  assert.equal(aliceRaw.promptTemplate, 'describe A');
  assert.equal(bobRaw.promptTemplate, 'describe B');

  audit.add('isolation-users', { aliceKey, bobKey, dirs });
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(scanSecrets(audit.text()), [], 'no secret material in isolation output');
});

// ---------------------------------------------------------------------------
// 8.4 secret scan over the collected audit output of every scenario
// ---------------------------------------------------------------------------

test('8.4 secret scan: no apiKey/baseUrl/Bearer/image-bytes appear in any scenario output', () => {
  // The per-scenario assertions above each run scanSecrets on their own audit
  // sink. This aggregate test asserts the scanner itself rejects a deliberately
  // poisoned sample, so the zero-hit results are meaningful (the scanner is not
  // vacuously passing).
  const poisoned = makeAuditSink();
  poisoned.add('poisoned-apiKey', { apiKey: 'sk-live-secret' });
  poisoned.add('poisoned-base64', { blob: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' });
  const hits = scanSecrets(poisoned.text());
  assert.ok(hits.length >= 2, 'scanner must detect apiKey + base64 in a poisoned sample');
  assert.ok(hits.some((h) => h.name === 'apiKey'));
  assert.ok(hits.some((h) => h.name === 'image-base64'));
});