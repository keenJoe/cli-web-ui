/**
 * Per-user vision-bridge config persistence.
 *
 * Owns the on-disk layout under `<root>/users/<sha256(userId)>/config.json`,
 * the atomic write (same-dir temp file + rename), the POSIX 0700/0600 modes,
 * and the strict whitelist parse on read. It performs no authorization: the
 * directory key is only a stable path-free name, and the caller is responsible
 * for resolving the authenticated user id.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decryptVisionBridgeSecret,
  encryptVisionBridgeSecret,
  defaultVisionBridgeKeyPath,
} from '@/shared/vision-bridge-crypto.js';

import {
  normalizeVisionBridgeStoredConfig,
  VISION_BRIDGE_API_KEY_KEEP,
  type VisionBridgeStoredConfigV1,
} from '../../../shared/vision-bridge.js';

/**
 * Canonical stored-config shape this repository persists. Reused so the config
 * service can build/validate a full record before handing it here.
 */
export type VisionBridgeStoredConfigShape = VisionBridgeStoredConfigV1;

/** Options for {@link createVisionBridgeConfigRepository}. */
export type VisionBridgeConfigRepositoryOptions = {
  /**
   * Config root directory. Tests inject a temp dir; production defaults to
   * `~/.cloudcli/vision-bridge` so the real process never runs against a test
   * temporary filesystem by accident.
   */
  root?: string;
};

/** Persistence + parsing surface the vision-bridge config service consumes. */
export interface VisionBridgeConfigRepository {
  /** Reads and strictly parses the user's config (apiKey decrypted), or null when absent/corrupt. */
  read(userId: string | number): Promise<VisionBridgeStoredConfigShape | null>;
  /** Atomically persists a fully normalized config, encrypting apiKey at rest. */
  save(userId: string | number, config: VisionBridgeStoredConfigShape): Promise<void>;
  /** Absolute path to the user's config.json (for the launch-policy resolver). */
  getConfigPath(userId: string | number): string;
  /** Absolute path to the master-key file the live child decrypts apiKey with. */
  getKeyPath(): string;
  /**
   * Distinguishes a missing config from a corrupt (present-but-unparseable)
   * one so the launch-policy resolver can emit a diagnostic for the latter.
   */
  readStatus(userId: string | number): Promise<'missing' | 'corrupt' | 'valid'>;
}

const DEFAULT_ROOT = () => path.join(os.homedir(), '.cloudcli', 'vision-bridge');

/** 64-char lowercase hex SHA-256 over the UTF-8 byte encoding of String(userId). */
export function visionBridgeUserKey(userId: string | number): string {
  return createHash('sha256').update(String(userId), 'utf8').digest('hex');
}

/** Creates a per-user config repository rooted at the supplied (or default) root. */
export function createVisionBridgeConfigRepository(
  options: VisionBridgeConfigRepositoryOptions = {},
): VisionBridgeConfigRepository {
  const root = options.root ?? DEFAULT_ROOT();

  // Per-user-key mutex so concurrent saves for the SAME user serialize; a
  // process-level map keyed by user key, with a single-chained promise per key.
  // ponytail: one global map of per-key chains covers concurrent PUTs; upgrade
  // to a bounded queue only if a single user saturates writes.
  const writeChains = new Map<string, Promise<unknown>>();

  const userDir = (userId: string | number): string =>
    path.join(root, 'users', visionBridgeUserKey(userId));
  const configPath = (userId: string | number): string =>
    path.join(userDir(userId), 'config.json');
  const keyPath = defaultVisionBridgeKeyPath(root);

  /** Decrypts any stored apiKey before handing the config to the caller. */
  const decryptStored = async (config: VisionBridgeStoredConfigV1): Promise<VisionBridgeStoredConfigV1> => {
    if (!config.apiKey) {
      return config;
    }
    const decrypted = await decryptVisionBridgeSecret(config.apiKey, keyPath);
    // A null decrypt means a forged/undecryptable blob: drop the key rather
    // than expose garbage.
    if (decrypted === null) {
      const { apiKey: _dropped, ...rest } = config;
      return rest;
    }
    return { ...config, apiKey: decrypted };
  };

  /** Encrypts apiKey in-place before serializing to disk. */
  const encryptStored = async (
    config: VisionBridgeStoredConfigV1,
  ): Promise<VisionBridgeStoredConfigV1> => {
    if (!config.apiKey || config.apiKey === VISION_BRIDGE_API_KEY_KEEP) {
      return config;
    }
    return { ...config, apiKey: await encryptVisionBridgeSecret(config.apiKey, keyPath) };
  };

  const chainedWrite = <T>(userId: string | number, op: () => Promise<T>): Promise<T> => {
    const key = visionBridgeUserKey(userId);
    const previous = writeChains.get(key) ?? Promise.resolve();
    const next = previous.then(op, op);
    writeChains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };

  return {
    getConfigPath: configPath,
    getKeyPath: () => keyPath,

    async read(userId) {
      try {
        const raw = await fs.readFile(configPath(userId), 'utf8');
        const parsed = normalizeVisionBridgeStoredConfig(JSON.parse(raw));
        return parsed ? await decryptStored(parsed) : null;
      } catch {
        // Missing or unreadable/corrupt config is indistinguishable to the
        // caller: both mean "no valid config yet".
        return null;
      }
    },

    async readStatus(userId) {
      try {
        const raw = await fs.readFile(configPath(userId), 'utf8');
        const parsed = JSON.parse(raw);
        return normalizeVisionBridgeStoredConfig(parsed) ? 'valid' : 'corrupt';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' ? 'missing' : 'corrupt';
      }
    },

    save(userId, config) {
      return chainedWrite(userId, async () => {
        const dir = userDir(userId);
        const file = configPath(userId);

        // POSIX uses 0700 for the directory, 0600 for the file. The mode is
        // applied at mkdir/open time; on Windows these mode bits are a no-op
        // and the app-directory ACL is intentionally left unchanged.
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });

        const toStore = await encryptStored(config);
        const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
        const serialized = `${JSON.stringify(toStore, null, 2)}\n`;

        try {
          await fs.writeFile(temp, serialized, { mode: 0o600 });
          await fs.rename(temp, file);
        } catch (error) {
          // Best-effort temp cleanup; the old file (if any) is untouched because
          // rename is atomic and never partially overwrites.
          try {
            await fs.unlink(temp);
          } catch {
            // Ignore: the temp file may not have been created yet.
          }
          throw error;
        }
      });
    },
  };
}