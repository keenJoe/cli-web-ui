/**
 * Shared plumbing for the provider characterization suite.
 *
 * These tests lock the *pre-refactor* observable behavior of every provider
 * adapter (task 1.1 / R15 of the `refactor-provider-seams` change). They feed
 * fixed native event sequences into the seams each provider already exposes and
 * record the normalized event shape and order as a golden JSON file.
 *
 * Hard rules for everything in this directory:
 * - no network, no real CLI, no real process spawn;
 * - production code is read-only — a scenario that cannot be reached through an
 *   existing seam is documented in `README.md`, never enabled by a code change.
 *
 * Consumed only by the `*.characterization.test.ts` files next to this module.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type {
  NormalizedMessage,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
} from '@/shared/types.js';

const GOLDEN_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');

/**
 * Anything the adapters stamp with `Date.now()` during this run is volatile.
 * Timestamps that predate the process are fixture-supplied and stay verbatim,
 * which is what makes "the adapter honored the native timestamp" observable.
 */
const RUN_START_MS = Date.now() - 5_000;

/** `generateMessageId()` produces `<kind>_<uuid>`; those ids carry no meaning. */
const GENERATED_ID_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function redactString(value: string): string {
  if (GENERATED_ID_PATTERN.test(value)) {
    return '<generated-id>';
  }
  if (ISO_TIMESTAMP_PATTERN.test(value) && Date.parse(value) >= RUN_START_MS) {
    return '<generated-timestamp>';
  }
  return value;
}

function redactVolatileValues(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactVolatileValues);
  }
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = redactVolatileValues(entry);
    }
    return redacted;
  }
  return value;
}

/**
 * Compares one recorded observation against its golden file.
 *
 * Run with `UPDATE_GOLDEN=1` to (re)record. Re-recording is only legitimate for
 * a deliberate BREAKING change, which must be called out in the commit.
 */
export function assertGolden(goldenName: string, observed: unknown): void {
  // JSON round-tripping drops `undefined` properties on both sides so the
  // comparison matches what a client would actually receive over the wire.
  const normalized = JSON.parse(JSON.stringify(redactVolatileValues(observed)));
  const goldenPath = path.join(GOLDEN_DIRECTORY, `${goldenName}.json`);

  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIRECTORY, { recursive: true });
    writeFileSync(goldenPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return;
  }

  let expected: unknown;
  try {
    expected = JSON.parse(readFileSync(goldenPath, 'utf8'));
  } catch {
    assert.fail(`Missing golden fixture ${goldenName}.json — re-record with UPDATE_GOLDEN=1.`);
  }

  assert.deepEqual(normalized, expected, `characterization drift in ${goldenName}`);
}

/**
 * Records the normalized event stream a provider emits through the runtime
 * writer, plus every `setSessionId` binding, in emission order.
 */
export function createRecordingWriter() {
  const events: unknown[] = [];
  const boundSessionIds: string[] = [];

  return {
    events,
    boundSessionIds,
    writer: {
      userId: null,
      isWebSocketWriter: true,
      send(data: unknown) {
        events.push(data);
      },
      setSessionId(sessionId: string) {
        boundSessionIds.push(sessionId);
      },
    },
  };
}

const EMPTY_MODEL_CATALOG: ProviderModelsDefinition = {
  OPTIONS: [],
  DEFAULT: '',
} as ProviderModelsDefinition;

/**
 * Builds the `ProviderRuntimeContext` that `provider-runtime.service.ts` would
 * hand a runtime, with every application lookup replaced by a fixed value.
 * This is the injection point all four `.js` runtimes and the Pi runtime read.
 */
export function createRuntimeContextDouble(
  overrides: Partial<ProviderRuntimeContext> = {},
): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => EMPTY_MODEL_CATALOG,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

/**
 * Reduces a normalized stream to the comparable spine used by the `replay`
 * scenario: live and persisted history must agree on kind/role/content order.
 */
export function toEventSpine(messages: NormalizedMessage[]) {
  return messages.map((message) => ({
    kind: message.kind,
    role: message.role ?? null,
    content: message.content ?? null,
    toolName: message.toolName ?? null,
  }));
}

/**
 * Records, in order, how a runtime interrogates its `ProviderRuntimeContext`
 * while preparing a run.
 *
 * The `resume` scenario hinges on ordering: every runtime must resolve the
 * provider-native session id *before* it builds its SDK query / CLI argv, so
 * suspending the next context call freezes the run at an observable point
 * without ever reaching a spawn.
 */
export function createContextCallLog() {
  const calls: Array<{ call: string; args: unknown[] }> = [];

  return {
    calls,
    record<TArgs extends unknown[], TResult>(
      call: string,
      implementation: (...args: TArgs) => TResult,
    ) {
      return (...args: TArgs): TResult => {
        calls.push({ call, args });
        return implementation(...args);
      };
    },
  };
}

/**
 * Runs `runTest` against a throwaway sessions database.
 *
 * `resolveDatabasePath()` (`database/connection.ts:37`) reads `DATABASE_PATH` on
 * every reconnect, so closing the singleton and repointing the variable is
 * enough to keep `sessionsDb` writes away from the real `~/.cloudcli/auth.db`.
 * Mirrors `database/tests/sessions-provider-mapping.test.ts`. Claude and Codex
 * resolve their transcript file through `sessionsDb.getSessionById`, which is
 * what makes their `fetchHistory` reachable from this suite.
 */
export async function withIsolatedSessionsDatabase(
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'characterization-sessions-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase([]);

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
