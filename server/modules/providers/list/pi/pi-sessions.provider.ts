import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, sliceTailPage } from '@/shared/utils.js';

import { PiPaths } from './pi-paths.provider.js';
import {
  PiSessionStore,
  type PiSessionEntry,
  type PiSessionMessage,
  type PiSessionSnapshot,
} from './pi-session-store.provider.js';

const PROVIDER = 'pi';

/** Namespaced custom type the vision-bridge extension persists (design.md D4). */
const VISION_BRIDGE_CUSTOM_TYPE = 'cloudcli.vision-bridge.v1';
/** Single-page history image byte cap (design.md data model). */
const MAX_HISTORY_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Raw shape accepted by `normalizeMessage`: a single normalized message from a
 * `PiSessionSnapshot` (see `PiSessionStore`). Each `content` block becomes one
 * `NormalizedMessage` with a stable id `<entryId>:<contentIndex>`.
 */
type PiRawMessage = PiSessionMessage;

/**
 * History result augmented with the session's current model, so the sessions
 * layer transparently forwards the snapshot's `currentModel` without a second
 * file read.
 */
export type PiFetchHistoryResult = FetchHistoryResult & {
  currentModel: PiSessionSnapshot['currentModel'];
};

function isPiRawMessage(value: unknown): value is PiRawMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.entryId === 'string'
    && typeof record.role === 'string'
    && typeof record.message === 'object'
    && record.message !== null;
}

function toRole(role: string): 'user' | 'assistant' | undefined {
  return role === 'user' || role === 'assistant' ? role : undefined;
}

type PiDisplayContentBlock = {
  index: number;
  kind: 'text' | 'thinking';
  content: string;
};

/**
 * Extracts ordered user-visible content from a Pi message. The original array
 * index is retained so REST message ids remain stable across repeated reads.
 */
function extractContentBlocks(message: Record<string, unknown>): PiDisplayContentBlock[] {
  const content = message.content;

  if (typeof content === 'string') {
    return [{ index: 0, kind: 'text', content }];
  }

  if (Array.isArray(content)) {
    const blocks: PiDisplayContentBlock[] = [];
    content.forEach((block, index) => {
      if (typeof block === 'object' && block !== null) {
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') {
          blocks.push({ index, kind: 'text', content: record.text });
        } else if (record.type === 'thinking' && typeof record.thinking === 'string') {
          blocks.push({ index, kind: 'thinking', content: record.thinking });
        }
      }
    });
    return blocks;
  }

  return [];
}

function normalizeMessageTimestamp(timestamp: unknown): string | undefined {
  if (typeof timestamp === 'string') {
    return timestamp;
  }
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  return undefined;
}

/** Raw-byte SHA-256 of a base64 Pi image block (matches the extension's hash). */
function imageContentHash(base64: string): string {
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

/** One projected Pi user-image attachment (ChatImage-compatible data URL). */
type PiHistoryImage = {
  /** `data:<mime>;base64,<bytes>` data URL; omitted when over the byte cap. */
  data?: string;
  mimeType: string;
  contentHash: string;
};

/** Mutable per-response image budget so repeated reads share one 32 MiB cap. */
type ImageByteBudget = { remainingBytes: number };

/**
 * Projects image blocks on a user message into `ChatImage`-compatible data
 * URLs, capped by the shared 32 MiB per-response budget. Blocks past the cap
 * are returned WITHOUT `data` (a safe "image unavailable" placeholder) rather
 * than dropping the identity: the frontend can still show the position.
 */
function extractUserImages(
  message: Record<string, unknown>,
  budget: ImageByteBudget,
): PiHistoryImage[] | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const images: PiHistoryImage[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'image') continue;
    if (typeof record.data !== 'string') continue;

    const mimeType = typeof record.mimeType === 'string' && record.mimeType
      ? record.mimeType
      : 'image/png';
    const contentHash = imageContentHash(record.data);
    const rawBytes = Buffer.byteLength(Buffer.from(record.data, 'base64'));

    if (budget.remainingBytes >= rawBytes) {
      budget.remainingBytes -= rawBytes;
      images.push({ data: `data:${mimeType};base64,${record.data}`, mimeType, contentHash });
    } else {
      images.push({ mimeType, contentHash });
    }
  }

  return images.length > 0 ? images : undefined;
}

/** Terminal phase inferred from a persisted batch item (batch entries never store `started`). */
function inferTerminalPhase(item: Record<string, unknown>): 'succeeded' | 'failed' | 'skipped' {
  if (item.errorCode === 'LIMIT_EXCEEDED') {
    return 'skipped';
  }
  return typeof item.errorCode === 'string' && item.errorCode ? 'failed' : 'succeeded';
}

/**
 * Projects a namespaced vision-bridge custom entry into stable `vision_bridge`
 * normalized messages. Unknown schema versions are ignored (with a diagnostic)
 * rather than corrupting the session; each terminal item keeps its stored
 * `source` identity (clientMessageId / toolCallId / unique sourceEntryId) so
 * the frontend can anchor the card without guessing the nearest message.
 */
function projectVisionBridgeEntry(
  entry: PiSessionEntry,
  sessionId: string | null,
): NormalizedMessage[] {
  const data = entry.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    console.warn('[Pi] ignoring vision-bridge custom entry with unknown schemaVersion');
    return [];
  }
  if (!Array.isArray(record.items)) {
    return [];
  }

  const batchId = typeof record.batchId === 'string' ? record.batchId : '';
  const runId = typeof record.runId === 'string' ? record.runId : '';
  const nativeSessionId = typeof record.nativeSessionId === 'string'
    ? record.nativeSessionId
    : undefined;

  const messages: NormalizedMessage[] = [];
  for (const item of record.items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const itemRecord = item as Record<string, unknown>;
    const observationId = typeof itemRecord.observationId === 'string'
      ? itemRecord.observationId
      : '';
    if (!observationId) continue;

    const phase = inferTerminalPhase(itemRecord);
    const event = {
      schemaVersion: 1,
      batchId,
      runId,
      // Authoritative app identity is the fetched session, not the stored
      // (child-correlation) claim (design.md D7).
      appSessionId: sessionId ?? '',
      ...(nativeSessionId ? { nativeSessionId } : {}),
      observationId,
      phase,
      source: itemRecord.source,
      imageIndex: itemRecord.imageIndex,
      contentHash: itemRecord.contentHash,
      ...(itemRecord.model ? { model: itemRecord.model } : {}),
      ...(typeof itemRecord.description === 'string' ? { description: itemRecord.description } : {}),
      ...(typeof itemRecord.errorCode === 'string' ? { errorCode: itemRecord.errorCode } : {}),
      ...(typeof itemRecord.errorMessage === 'string' ? { errorMessage: itemRecord.errorMessage } : {}),
      ...(typeof itemRecord.durationMs === 'number' ? { durationMs: itemRecord.durationMs } : {}),
      cached: Boolean(itemRecord.cached),
    };

    messages.push(createNormalizedMessage({
      id: `${entry.id}:${observationId}`,
      kind: 'vision_bridge',
      provider: PROVIDER,
      sessionId: sessionId ?? '',
      timestamp: normalizeMessageTimestamp(entry.timestamp),
      event,
      runId,
      appSessionId: sessionId ?? '',
      ...(nativeSessionId ? { nativeSessionId } : {}),
      observationId,
      phase,
      source: itemRecord.source,
      imageIndex: itemRecord.imageIndex,
      contentHash: itemRecord.contentHash,
    }));
  }
  return messages;
}

/**
 * Sessions adapter for Pi. Consumes immutable `PiSessionStore` snapshots and
 * exposes normalized history with the shared tail pagination contract. User
 * image blocks are preserved as data URLs (D1/D4) and namespaced vision-bridge
 * custom entries are projected as `vision_bridge` messages (D4/D7).
 */
export class PiSessionsProvider implements IProviderSessions {
  private readonly paths: PiPaths;

  constructor(paths: PiPaths = new PiPaths()) {
    this.paths = paths;
  }

  normalizeMessage(
    raw: unknown,
    sessionId: string | null,
    imageBudget: ImageByteBudget = { remainingBytes: MAX_HISTORY_IMAGE_TOTAL_BYTES },
  ): NormalizedMessage[] {
    if (!isPiRawMessage(raw)) {
      return [];
    }

    const { entryId, role, message } = raw;
    const timestamp = normalizeMessageTimestamp(message.timestamp);
    const normalizedRole = toRole(role);

    // User messages keep their original image blocks as data URLs alongside
    // the text, so the original image is never lost to a text-only projection.
    if (role === 'user') {
      const images = extractUserImages(message, imageBudget);
      const textBlocks = extractContentBlocks(message)
        .filter((block) => block.kind === 'text')
        .map((block) => block.content);
      const content = textBlocks.join('\n');

      // An image-only user turn still produces one user bubble (empty text).
      if (!content && !images) {
        return [];
      }
      return [createNormalizedMessage({
        id: `${entryId}:0`,
        sessionId: sessionId ?? '',
        timestamp,
        provider: PROVIDER,
        kind: 'text',
        role: normalizedRole,
        content,
        ...(images ? { images } : {}),
      })];
    }

    return extractContentBlocks(message).map(({ index, kind, content }) => createNormalizedMessage({
      id: `${entryId}:${index}`,
      sessionId: sessionId ?? '',
      timestamp,
      provider: PROVIDER,
      kind,
      content,
      ...(kind === 'text' ? { role: normalizedRole } : {}),
    }));
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<PiFetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    const indexedFilePath = options.sessionFilePath;
    const filePath = indexedFilePath && fsSync.existsSync(indexedFilePath)
      ? indexedFilePath
      : this.resolveSessionFile(providerSessionId);
    if (!filePath) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null, currentModel: null };
    }

    const snapshot = PiSessionStore.load(filePath);
    const imageBudget: ImageByteBudget = {
      remainingBytes: MAX_HISTORY_IMAGE_TOTAL_BYTES,
    };

    const normalized: NormalizedMessage[] = [];
    // Iterate the active branch in order so custom entries interleave with the
    // messages they belong to (a batch entry is appended at turn_end).
    for (const entry of snapshot.entries) {
      if (entry.type === 'message') {
        const message = entry.message;
        if (typeof message !== 'object' || message === null) continue;
        const role = typeof (message as Record<string, unknown>).role === 'string'
          ? (message as Record<string, unknown>).role
          : 'unknown';
        normalized.push(...this.normalizeMessage({
          entryId: entry.id,
          role,
          message: message as Record<string, unknown>,
        }, sessionId, imageBudget));
      } else if (entry.type === 'custom' && entry.customType === VISION_BRIDGE_CUSTOM_TYPE) {
        normalized.push(...projectVisionBridgeEntry(entry, sessionId));
      }
    }

    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const total = normalized.length;
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      currentModel: snapshot.currentModel,
    };
  }

  /**
   * Resolves a session id to its `<id>.jsonl` file by scanning the configured
   * session roots. Returns null when no matching file exists.
   */
  private resolveSessionFile(sessionId: string): string | null {
    for (const root of this.paths.getSessionRoots()) {
      const candidate = path.join(root, `${sessionId}.jsonl`);
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}
