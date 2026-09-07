/**
 * Vision-bridge secret encryption at rest.
 *
 * The vision-bridge config may now carry a user-supplied custom-gateway API
 * key. That key must never be written to disk in plaintext. This helper
 * encrypts it with AES-256-GCM under a machine-local master key stored in a
 * 0600 file (`<configRoot>/.master-key`), created (with a 32-byte random
 * secret) on first use.
 *
 * Both the backend repository (`server/modules/vision-bridge`) and the live Pi
 * child extension (`extensions/cloudcli-vision-bridge.ts`) import this module,
 * so they share the exact same key material from the same on-disk path. The
 * child receives the master-key path via `CLOUDCLI_VISION_BRIDGE_KEY_PATH`.
 *
 * Scope note: this is defense-in-depth for a local single-user desktop app.
 * A process that can read the app's config directory can also read the master
 * key; the guarantee is that the key never appears verbatim in `config.json`,
 * logs, the browser, or the public API — not that it is safe against a local
 * attacker with full filesystem access.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CIPHER = 'aes-256-gcm';

/** Default master-key path, sibling of the config root (production). */
export function defaultVisionBridgeKeyPath(configRoot = path.join(os.homedir(), '.cloudcli', 'vision-bridge')): string {
  return path.join(configRoot, '.master-key');
}

/**
 * Reads the 32-byte master key, creating it (0600) if absent. Returns the raw
 * key bytes. Never logs the key.
 */
export async function loadOrCreateMasterKey(keyPath: string): Promise<Buffer> {
  try {
    const existing = await fs.readFile(keyPath);
    if (existing.length === KEY_BYTES) {
      return existing;
    }
    // Wrong length -> treat as absent and regenerate.
  } catch {
    // Absent/unreadable -> create below.
  }

  const dir = path.dirname(keyPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  // Write atomically so a crash cannot leave a truncated key.
  const tmp = `${keyPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, key, { mode: 0o600 });
    await fs.rename(tmp, keyPath);
    await fs.chmod(keyPath, 0o600);
  } catch (error) {
    try {
      await fs.unlink(tmp);
    } catch {
      // Ignore: the temp may not exist yet.
    }
    throw error;
  }
  return key;
}

/**
 * Encrypts `plaintext` (UTF-8) to a compact `v1:<iv-hex>:<tag-hex>:<data-hex>`
 * string. Returns an empty string for an empty plaintext (no key stored).
 */
export async function encryptVisionBridgeSecret(
  plaintext: string,
  keyPath: string,
): Promise<string> {
  if (plaintext === '') {
    return '';
  }
  const key = await loadOrCreateMasterKey(keyPath);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${data.toString('hex')}`;
}

/**
 * Decrypts a `v1:...` blob produced by {@link encryptVisionBridgeSecret}.
 * Returns `''` for an empty input and `null` on any malformed/undecryptable
 * input (so an attacker-forged blob degrades to "no key" rather than a throw).
 */
export async function decryptVisionBridgeSecret(
  blob: string,
  keyPath: string,
): Promise<string | null> {
  if (blob === '') {
    return '';
  }
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return null;
  }
  try {
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const data = Buffer.from(parts[3], 'hex');
    if (iv.length !== IV_BYTES || tag.length !== GCM_TAG_BYTES || data.length === 0) {
      return null;
    }
    const key = await loadOrCreateMasterKey(keyPath);
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Stable 64-hex SHA-256 of a secret, used only as a cheap change-detector so
 * the public config can report `hasApiKey` without leaking the key.
 */
export function hashSecretBytes(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}