import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repairMojibakeName } from '../../shared/encoding.js';
import type { VisionBridgeImageErrorCode } from '../../shared/vision-bridge.js';

/**
 * Shared chat-attachment plumbing for every provider runtime.
 *
 * Uploaded chat files are persisted once in the global `~/.cloudcli/assets`
 * folder and referenced by absolute path everywhere else:
 * - Claude: paths are read back into base64 `image` content blocks.
 * - Codex: paths become `local_image` input items.
 * - General files: verified paths are appended inside a `<files_input>` tag,
 *   which every provider history adapter strips back out for display.
 * - Cursor/OpenCode images: paths use the equivalent `<images_input>` tag.
 *
 * The chat UI loads them through dedicated `/api/assets/images/:filename` and
 * `/api/assets/files/:filename` routes, which serve only from this folder.
 */

/** Global storage folder for uploaded chat image attachments. */
export function getGlobalImageAssetsDir(): string {
  return path.join(os.homedir(), '.cloudcli', 'assets');
}

export type ImageAttachmentDescriptor = {
  /** Project-relative (preferred) or absolute path to the stored image. */
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
  /** Raw-byte SHA-256 (64 lowercase hex) computed at upload; empty for old attachments. */
  contentHash?: string;
};

/** Provider-neutral descriptor used for both image and non-image chat attachments. */
export type ChatAttachmentDescriptor = ImageAttachmentDescriptor;

/** Media types the Claude Messages API accepts for base64 image blocks. */
const CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Accepts a loosely typed chat attachment payload and returns only well-formed
 * descriptors. The websocket gateway and provider adapters use this to handle
 * current `attachments` payloads and legacy image path arrays consistently.
 */
export function normalizeAttachmentDescriptors(attachments: unknown): ChatAttachmentDescriptor[] {
  if (!Array.isArray(attachments)) {
    return [];
  }

  const descriptors: ChatAttachmentDescriptor[] = [];
  for (const entry of attachments) {
    if (typeof entry === 'string' && entry.trim()) {
      descriptors.push({ path: entry.trim() });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const entryPath = typeof record.path === 'string' ? record.path.trim() : '';
      if (!entryPath) {
        continue;
      }
      const descriptor: ChatAttachmentDescriptor = { path: entryPath };
      if (typeof record.name === 'string') {
        descriptor.name = repairMojibakeName(record.name);
      }
      if (typeof record.mimeType === 'string') {
        descriptor.mimeType = record.mimeType;
      }
      if (typeof record.size === 'number' && Number.isFinite(record.size)) {
        descriptor.size = record.size;
      }
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

/** Backward-compatible image-specific alias used by existing provider adapters. */
export function normalizeImageDescriptors(images: unknown): ImageAttachmentDescriptor[] {
  return normalizeAttachmentDescriptors(images);
}

const IMAGE_FILE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/**
 * Determines whether the websocket gateway should route an attachment through
 * provider-native image input instead of the general file reference channel.
 */
export function isImageAttachmentDescriptor(descriptor: ChatAttachmentDescriptor): boolean {
  if (descriptor.mimeType && CLAUDE_IMAGE_MEDIA_TYPES.has(descriptor.mimeType)) {
    return true;
  }
  return IMAGE_FILE_EXTENSIONS.has(path.extname(descriptor.path).toLowerCase());
}

/** Normalizes Windows separators so stored references stay portable. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Resolves a project-relative image path against the run's working directory. */
export function resolveImageAbsolutePath(cwd: string | undefined, imagePath: string): string {
  if (path.isAbsolute(imagePath)) {
    return imagePath;
  }
  return path.resolve(cwd || process.cwd(), imagePath);
}

function isPathInsideDirectory(candidate: string, directory: string): boolean {
  // resolve + startsWith(root + separator) is the containment idiom CodeQL
  // recognizes as a path-injection barrier, and matches the check used by
  // resolveImageAssetFile in the assets module. The root itself never
  // matches (no trailing separator after resolve), only entries below it.
  const resolvedRoot = path.resolve(directory) + path.sep;
  return path.resolve(candidate).startsWith(resolvedRoot);
}

function getDirectoryPathVariants(directory: string): string[] {
  const resolvedDirectory = path.resolve(directory);
  try {
    const canonicalDirectory = path.resolve(realpathSync(directory));
    return canonicalDirectory === resolvedDirectory
      ? [resolvedDirectory]
      : [resolvedDirectory, canonicalDirectory];
  } catch {
    return [resolvedDirectory];
  }
}

/**
 * Second layer of the image trust boundary (the first is the chat.send filter
 * in the websocket gateway): provider builders only reference files that live
 * in the global upload store or inside the run's working directory — places
 * the agent could already access on its own. Anything else (e.g. `~/.ssh`) is
 * refused, so a caller-supplied descriptor can never leak arbitrary files.
 */
export function isAllowedImageSourcePath(resolvedPath: string, cwd?: string): boolean {
  return [getGlobalImageAssetsDir(), cwd || process.cwd()].some((directory) =>
    getDirectoryPathVariants(directory).some((directoryVariant) =>
      isPathInsideDirectory(resolvedPath, directoryVariant)
    )
  );
}

/**
 * Resolves the media type for one image, preferring the uploaded mime type and
 * falling back to the file extension.
 */
export function resolveImageMediaType(descriptor: ImageAttachmentDescriptor): string | null {
  if (descriptor.mimeType) {
    return descriptor.mimeType;
  }
  const extension = path.extname(descriptor.path).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[extension] || null;
}

const IMAGES_INPUT_TAG_PATTERN = /\s*<images_input>([\s\S]*?)<\/images_input>\s*/g;

// One image reference recovered from an <images_input> block: the stored
// asset path plus the user's original filename when it was recorded.
export type ParsedImageAttachment = {
  path: string;
  name?: string;
};

// Result of stripping an <images_input> block out of persisted prompt text.
// `imagePaths` mirrors `attachments` for callers that only need paths.
export type ParsedImagesInput = {
  text: string;
  imagePaths: string[];
  attachments: ParsedImageAttachment[];
};

/**
 * Appends the `<images_input>` reference block used by the Cursor and
 * OpenCode CLIs. The block carries one numbered line per attachment with
 * the stored file path (quote-free on purpose — Windows .cmd shims mangle
 * quoted text) and the user's original filename, plus an explicit instruction
 * to read the files and keep the block out of the reply. The same block is
 * stripped back out of persisted history by {@link parseImagesInputTag}.
 */
export function appendImagesInputTag(prompt: string, images: unknown): string {
  const descriptors = normalizeImageDescriptors(images);
  if (descriptors.length === 0) {
    return prompt;
  }

  const entryLines = descriptors.map((descriptor, index) => {
    const entryPath = toPosixPath(descriptor.path);
    // Parentheses and newlines would break the "(original name: ...)" suffix
    // the parser looks for, so drop them from the display name.
    const cleanName = descriptor.name?.replace(/[()\r\n]/g, '').trim();
    return cleanName
      ? `${index + 1}. ${entryPath} (original name: ${cleanName})`
      : `${index + 1}. ${entryPath}`;
  });

  return [
    prompt,
    '',
    '<images_input>',
    `The user attached ${descriptors.length} image(s) to this message. Read each file listed below with your file/image reading tool and use what you see to answer the prompt above. Respond as if the images were attached directly. Do not mention this block or the file paths unless the user asks about them.`,
    ...entryLines,
    '</images_input>',
  ].join('\n');
}

const FILES_INPUT_TAG_PATTERN = /\s*<files_input>([\s\S]*?)<\/files_input>\s*/g;

/**
 * Appends a provider-neutral file reference block to a prompt. Provider agents
 * receive only server-validated paths from the global attachment store and can
 * inspect each file with their normal filesystem tools.
 */
export function appendFilesInputTag(prompt: string, files: unknown): string {
  const descriptors = normalizeAttachmentDescriptors(files);
  if (descriptors.length === 0) {
    return prompt;
  }

  const entryLines = descriptors.map((descriptor, index) => {
    const entryPath = toPosixPath(descriptor.path);
    const cleanName = descriptor.name?.replace(/[()\r\n]/g, '').trim();
    return cleanName
      ? `${index + 1}. ${entryPath} (original name: ${cleanName})`
      : `${index + 1}. ${entryPath}`;
  });

  return [
    prompt,
    '',
    '<files_input>',
    `The user attached ${descriptors.length} file(s) to this message. Read each file listed below with your file reading tools and use its contents to answer the prompt above. Do not mention this block or the file paths unless the user asks about them.`,
    ...entryLines,
    '</files_input>',
  ].join('\n');
}

// Matches one numbered attachment entry inside the tag body. Works for both
// the multi-line block and the Windows-flattened single-line form, where the
// next ` N. ` marker (or the end of the body) delimits each entry.
const IMAGES_INPUT_ENTRY_PATTERN = /\d+\.\s+(.+?)(?=\s+\d+\.\s+|\s*$)/g;

const ORIGINAL_NAME_SUFFIX_PATTERN = /\(original name: ([^)]*)\)\s*$/;

function parseNumberedImageEntries(inner: string): ParsedImageAttachment[] {
  const attachments: ParsedImageAttachment[] = [];
  for (const entryMatch of inner.matchAll(IMAGES_INPUT_ENTRY_PATTERN)) {
    let entryText = entryMatch[1].trim();
    let name: string | undefined;

    const nameMatch = ORIGINAL_NAME_SUFFIX_PATTERN.exec(entryText);
    if (nameMatch) {
      name = nameMatch[1].trim() || undefined;
      entryText = entryText.slice(0, nameMatch.index).trim();
    }

    if (entryText) {
      attachments.push(name ? { path: toPosixPath(entryText), name } : { path: toPosixPath(entryText) });
    }
  }
  return attachments;
}

/**
 * Strips the last provider-neutral file reference block from persisted prompt
 * text and restores its attachment descriptors for chat history.
 */
export function parseFilesInputTag(text: string): {
  text: string;
  filePaths: string[];
  attachments: ParsedImageAttachment[];
} {
  if (typeof text !== 'string' || !text.includes('<files_input>')) {
    return { text, filePaths: [], attachments: [] };
  }

  let lastMatch: RegExpExecArray | null = null;
  FILES_INPUT_TAG_PATTERN.lastIndex = 0;
  for (let match = FILES_INPUT_TAG_PATTERN.exec(text); match; match = FILES_INPUT_TAG_PATTERN.exec(text)) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { text, filePaths: [], attachments: [] };
  }

  const attachments = parseNumberedImageEntries(lastMatch[1]);
  const stripped = (
    text.slice(0, lastMatch.index) + '\n' + text.slice(lastMatch.index + lastMatch[0].length)
  ).trim();

  return {
    text: stripped,
    filePaths: attachments.map((attachment) => attachment.path),
    attachments,
  };
}

/**
 * Strips one `<images_input>` block from persisted prompt text and returns
 * the clean text plus the referenced attachments (path and original name).
 *
 * Only the LAST block in the text is treated as the attachment carrier — the
 * composer always appends it at the end, so a user who literally typed
 * `<images_input>` earlier in their prompt keeps that text intact.
 *
 * Understands the numbered-line body in both its multi-line and
 * Windows-flattened single-line forms.
 */
export function parseImagesInputTag(text: string): ParsedImagesInput {
  if (typeof text !== 'string' || !text.includes('<images_input>')) {
    return { text, imagePaths: [], attachments: [] };
  }

  let lastMatch: RegExpExecArray | null = null;
  IMAGES_INPUT_TAG_PATTERN.lastIndex = 0;
  for (let match = IMAGES_INPUT_TAG_PATTERN.exec(text); match; match = IMAGES_INPUT_TAG_PATTERN.exec(text)) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { text, imagePaths: [], attachments: [] };
  }

  const attachments = parseNumberedImageEntries(lastMatch[1]);

  const stripped = (
    text.slice(0, lastMatch.index) + '\n' + text.slice(lastMatch.index + lastMatch[0].length)
  ).trim();

  return {
    text: stripped,
    imagePaths: attachments.map((attachment) => attachment.path),
    attachments,
  };
}

/** Maps raw image paths to the attachment shape carried by NormalizedMessage.images. */
export function toImageAttachments(imagePaths: string[]): Array<{ path: string }> {
  return imagePaths.map((imagePath) => ({ path: toPosixPath(imagePath) }));
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Builds the Claude user-message content list: the prompt text followed by one
 * base64 `image` block per attachment. Images the Claude API cannot accept
 * (e.g. SVG) or that fail to read are skipped with a warning so the prompt
 * itself still goes through.
 */
export async function buildClaudeUserContent(
  prompt: string,
  images: unknown,
  cwd?: string,
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [{ type: 'text', text: prompt }];

  for (const descriptor of normalizeImageDescriptors(images)) {
    const mediaType = resolveImageMediaType(descriptor);
    if (!mediaType || !CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType)) {
      console.warn(`[Images] Skipping unsupported Claude image type for ${descriptor.path}`);
      continue;
    }

    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd)) {
      console.warn(`[Images] Refusing to read image outside allowed roots: ${descriptor.path}`);
      continue;
    }

    try {
      const canonicalPath = await fs.realpath(resolvedPath);
      if (!isAllowedImageSourcePath(canonicalPath, cwd)) {
        console.warn(`[Images] Refusing to read symlinked image outside allowed roots: ${descriptor.path}`);
        continue;
      }

      const bytes = await fs.readFile(canonicalPath);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: bytes.toString('base64'),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Images] Failed to read image ${descriptor.path}: ${message}`);
    }
  }

  return blocks;
}

type CodexInputItem =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string };

/**
 * Builds the Codex `runStreamed` input list: prompt text plus one
 * `local_image` item per attachment, resolved to absolute paths so the Codex
 * runtime can read them regardless of its own working directory handling.
 */
export function buildCodexInputItems(prompt: string, images: unknown, cwd?: string): CodexInputItem[] {
  const items: CodexInputItem[] = [{ type: 'text', text: prompt }];
  for (const descriptor of normalizeImageDescriptors(images)) {
    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd)) {
      // Same trust boundary as buildClaudeUserContent — the Codex runtime
      // reads this file, so it must stay within the allowed roots.
      console.warn(`[Images] Refusing to attach image outside allowed roots: ${descriptor.path}`);
      continue;
    }
    items.push({
      type: 'local_image',
      path: resolvedPath,
    });
  }
  return items;
}

// ---------------------------
//----------------- TRUSTED PI IMAGE READER ------------
/**
 * Base64 image payload in the exact shape Pi's RPC `ImageContent` expects.
 * `readTrustedPiImages` produces these; the Pi runtime passes them to
 * `rpc.prompt()` unchanged (no data URL prefix, no path descriptor cast).
 */
export type PiImageContent = {
  /** Fixed image-content discriminator required by Pi RPC. */
  type: 'image';
  /** Base64-encoded raw image bytes. */
  data: string;
  /** Media type detected from the actual magic bytes. */
  mimeType: string;
};

/**
 * One per-image read failure from `readTrustedPiImages`. A single failure
 * never blocks the text prompt or the other valid images in the batch.
 */
export type ImageReadFailure = {
  /** Zero-based index into the descriptors array passed to the reader. */
  index: number;
  /** Stable, sanitized per-image error code. */
  errorCode: VisionBridgeImageErrorCode;
  /** Non-sensitive, human-readable reason for the failure. */
  reason: string;
};

/** Default per-image raw-byte cap (10 MiB) for the trusted Pi image reader. */
const DEFAULT_MAX_BYTES_PER_IMAGE = 10 * 1024 * 1024;
/** Default cumulative raw-byte cap (32 MiB) per read batch. */
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Checks that a resolved path is a direct child *file* of `directory`
 * (i.e. its parent is exactly the directory), accounting for the directory
 * itself being reachable through a symlink. This is stricter than the general
 * `isAllowedImageSourcePath` containment check: browser attachments must be
 * direct children of the upload store, never files in a subdirectory and never
 * files elsewhere on the machine (the run `cwd` is NOT an allowed root here).
 */
function isDirectChildOfDirectory(candidate: string, directory: string): boolean {
  const parent = path.dirname(path.resolve(candidate));
  return getDirectoryPathVariants(directory).includes(parent);
}

/**
 * Detects an image media type from real file bytes (magic numbers) only.
 * Extensions and the descriptor's `mimeType` field are deliberately ignored
 * because they are attacker-controllable. Returns `null` for SVG/BMP and
 * anything that is not JPEG, PNG, GIF, or WebP.
 */
function detectImageMagicMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 6) {
    const header = bytes.toString('ascii', 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Reads browser-attached images into safe Pi `ImageContent` payloads.
 *
 * This is the trusted boundary between host path attachments and Pi's image
 * input. It only ever accepts files that resolve (after `realpath`) to a
 * direct child of the global upload store (`getGlobalImageAssetsDir`); the
 * `cwd` option is used solely to resolve relative descriptor paths and is
 * never itself an allowed root. Each accepted file must be JPEG/PNG/GIF/WebP
 * by magic bytes, under `maxBytesPerImage` (default 10 MiB), and each batch is
 * under `maxTotalBytes` (default 32 MiB).
 *
 * Failures keep the original descriptor index and a sanitized error code, so
 * one bad image cannot block the text or the other valid images. Never casts
 * descriptor bytes through `as never` to pretend an arbitrary path is an image.
 */
export async function readTrustedPiImages(
  descriptors: readonly ChatAttachmentDescriptor[],
  options: {
    cwd?: string;
    maxBytesPerImage?: number;
    maxTotalBytes?: number;
  } = {},
): Promise<{ images: PiImageContent[]; failures: ImageReadFailure[] }> {
  const {
    cwd,
    maxBytesPerImage = DEFAULT_MAX_BYTES_PER_IMAGE,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = options;

  const assetsDir = getGlobalImageAssetsDir();
  const images: PiImageContent[] = [];
  const failures: ImageReadFailure[] = [];
  let totalBytes = 0;

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);

    // Browser attachments must be direct children of the upload store only.
    if (!isDirectChildOfDirectory(resolvedPath, assetsDir)) {
      failures.push({ index, errorCode: 'IMAGE_UNSAFE', reason: '图片不在受信的全局上传目录内' });
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(resolvedPath);
      // Re-check after symlink resolution so an in-store link cannot escape.
      if (!isDirectChildOfDirectory(canonicalPath, assetsDir)) {
        failures.push({ index, errorCode: 'IMAGE_UNSAFE', reason: '符号链接指向了上传目录之外' });
        continue;
      }
    } catch {
      failures.push({ index, errorCode: 'IMAGE_UNREADABLE', reason: '图片文件不存在或不可读取' });
      continue;
    }

    let stats;
    try {
      stats = await fs.stat(canonicalPath);
    } catch {
      failures.push({ index, errorCode: 'IMAGE_UNREADABLE', reason: '无法读取图片文件状态' });
      continue;
    }
    if (!stats.isFile()) {
      failures.push({ index, errorCode: 'IMAGE_UNREADABLE', reason: '目标不是普通文件' });
      continue;
    }
    if (stats.size > maxBytesPerImage) {
      failures.push({ index, errorCode: 'IMAGE_TOO_LARGE', reason: '单张图片超过大小上限' });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(canonicalPath);
    } catch {
      failures.push({ index, errorCode: 'IMAGE_UNREADABLE', reason: '图片内容读取失败' });
      continue;
    }

    // Re-check against real bytes so a file that grew between stat and read
    // is still rejected before it is projected as a Pi image.
    if (bytes.length > maxBytesPerImage) {
      failures.push({ index, errorCode: 'IMAGE_TOO_LARGE', reason: '单张图片超过大小上限' });
      continue;
    }

    const mimeType = detectImageMagicMimeType(bytes);
    if (!mimeType) {
      failures.push({ index, errorCode: 'IMAGE_UNSUPPORTED', reason: '仅支持 JPEG/PNG/GIF/WebP 图片' });
      continue;
    }

    if (totalBytes + bytes.length > maxTotalBytes) {
      failures.push({ index, errorCode: 'IMAGE_TOO_LARGE', reason: '图片总字节超过批次上限' });
      continue;
    }
    totalBytes += bytes.length;

    images.push({
      type: 'image',
      data: bytes.toString('base64'),
      mimeType,
    });
  }

  return { images, failures };
}
