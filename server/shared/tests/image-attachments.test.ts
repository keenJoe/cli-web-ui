import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  buildClaudeUserContent,
  buildCodexInputItems,
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  isAllowedImageSourcePath,
  normalizeImageDescriptors,
  parseFilesInputTag,
  parseImagesInputTag,
  readTrustedPiImages,
  resolveImageMediaType,
  toImageAttachments,
} from '@/shared/image-attachments.js';

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const SYMLINK_UNSUPPORTED_CODES = new Set(['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM']);

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function createSymlinkIfSupported(
  target: string,
  linkPath: string,
  type: 'dir' | 'file' | 'junction',
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      typeof error.code === 'string' &&
      SYMLINK_UNSUPPORTED_CODES.has(error.code)
    ) {
      return false;
    }
    throw error;
  }
}

test('normalizeImageDescriptors accepts objects and bare paths, drops junk', () => {
  const descriptors = normalizeImageDescriptors([
    { path: '.cloudcli/assets/a.png', name: 'a.png', mimeType: 'image/png' },
    'scripts/pic.jpg',
    { name: 'no-path.png' },
    42,
    null,
    '',
  ]);

  assert.deepEqual(descriptors, [
    { path: '.cloudcli/assets/a.png', name: 'a.png', mimeType: 'image/png' },
    { path: 'scripts/pic.jpg' },
  ]);
  assert.deepEqual(normalizeImageDescriptors(undefined), []);
  assert.deepEqual(normalizeImageDescriptors('not-an-array'), []);
});

test('normalizeAttachmentDescriptors preserves file metadata and identifies images', () => {
  const [pdf, image] = normalizeAttachmentDescriptors([
    { path: 'brief.pdf', name: 'brief.pdf', mimeType: 'application/pdf', size: 4096 },
    { path: 'diagram.PNG' },
  ]);

  assert.deepEqual(pdf, {
    path: 'brief.pdf',
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    size: 4096,
  });
  assert.equal(isImageAttachmentDescriptor(pdf), false);
  assert.equal(isImageAttachmentDescriptor(image), true);
});

test('appendFilesInputTag and parseFilesInputTag round-trip non-image files', () => {
  const prompt = 'Summarize the attached materials.';
  const tagged = appendFilesInputTag(prompt, [
    { path: 'C:\\Users\\x\\.cloudcli\\assets\\brief.pdf', name: 'Brief (final).pdf' },
    { path: '/tmp/cloudcli-assets/data.csv', name: 'data.csv' },
  ]);

  assert.ok(tagged.includes('<files_input>'));
  assert.ok(tagged.includes('The user attached 2 file(s)'));
  assert.deepEqual(parseFilesInputTag(tagged), {
    text: prompt,
    filePaths: [
      'C:/Users/x/.cloudcli/assets/brief.pdf',
      '/tmp/cloudcli-assets/data.csv',
    ],
    attachments: [
      { path: 'C:/Users/x/.cloudcli/assets/brief.pdf', name: 'Brief final.pdf' },
      { path: '/tmp/cloudcli-assets/data.csv', name: 'data.csv' },
    ],
  });
});

test('parseFilesInputTag handles Windows-flattened provider prompts', () => {
  const flattened = appendFilesInputTag(
    'inspect this',
    [{ path: 'C:/Users/x/.cloudcli/assets/report.docx', name: 'report.docx' }],
  ).replace(/\s*\r?\n\s*/g, ' ');

  const parsed = parseFilesInputTag(flattened);
  assert.equal(parsed.text, 'inspect this');
  assert.deepEqual(parsed.attachments, [
    { path: 'C:/Users/x/.cloudcli/assets/report.docx', name: 'report.docx' },
  ]);
});

test('appendImagesInputTag and parseImagesInputTag round-trip', () => {
  const prompt = 'Describe these screenshots.\n\nFocus on the header.';
  const tagged = appendImagesInputTag(prompt, [
    { path: '.cloudcli/assets/1-a.png' },
    { path: '.cloudcli\\assets\\2-b.jpg' },
  ]);

  assert.ok(tagged.startsWith(prompt));
  assert.ok(tagged.includes('<images_input>'));
  assert.ok(tagged.includes('</images_input>'));
  assert.ok(tagged.includes('The user attached 2 image(s)'));

  const parsed = parseImagesInputTag(tagged);
  assert.equal(parsed.text, prompt);
  // Backslashes are normalized so references stay portable.
  assert.deepEqual(parsed.imagePaths, ['.cloudcli/assets/1-a.png', '.cloudcli/assets/2-b.jpg']);
});

test('original filenames round-trip through the tag', () => {
  const tagged = appendImagesInputTag('compare these', [
    { path: 'C:/Users/x/.cloudcli/assets/1-a.png', name: 'screenshot (final).png' },
    { path: 'C:/Users/x/.cloudcli/assets/2-b.jpg' },
  ]);

  const parsed = parseImagesInputTag(tagged);
  assert.equal(parsed.text, 'compare these');
  // Parentheses are dropped from names so the "(original name: ...)" suffix
  // stays parseable; the path-only entry carries no name.
  assert.deepEqual(parsed.attachments, [
    { path: 'C:/Users/x/.cloudcli/assets/1-a.png', name: 'screenshot final.png' },
    { path: 'C:/Users/x/.cloudcli/assets/2-b.jpg' },
  ]);
});

test('only the LAST images_input block is treated as the attachment carrier', () => {
  const userTypedTag = 'What does <images_input> mean in this codebase?';
  const tagged = appendImagesInputTag(
    `${userTypedTag}\n\n<images_input>\nfake user block\n</images_input>\n\nAlso check this.`,
    [{ path: 'C:/Users/x/.cloudcli/assets/real.png' }],
  );

  const parsed = parseImagesInputTag(tagged);
  assert.ok(parsed.text.includes('fake user block'));
  assert.ok(parsed.text.includes('Also check this.'));
  assert.deepEqual(parsed.imagePaths, ['C:/Users/x/.cloudcli/assets/real.png']);
});

test('appendImagesInputTag without images returns the prompt untouched', () => {
  assert.equal(appendImagesInputTag('hello', []), 'hello');
  assert.equal(appendImagesInputTag('hello', undefined), 'hello');
});

test('parseImagesInputTag handles prompts flattened to one line for cmd.exe shims', () => {
  // Windows spawn runtimes collapse newlines before passing the argument to
  // .cmd-shimmed CLIs; the persisted prompt is then a single line.
  const flattened = appendImagesInputTag('now?', [{ path: 'C:/Users/x/.cloudcli/assets/a.jpg' }])
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();

  assert.ok(!flattened.includes('\n'));
  const parsed = parseImagesInputTag(flattened);
  assert.equal(parsed.text, 'now?');
  assert.deepEqual(parsed.imagePaths, ['C:/Users/x/.cloudcli/assets/a.jpg']);
});

test('parseImagesInputTag leaves text without a tag untouched', () => {
  const text = 'Just a normal prompt with [brackets] and JSON ["like"] content.';
  const parsed = parseImagesInputTag(text);
  assert.equal(parsed.text, text);
  assert.deepEqual(parsed.imagePaths, []);
});

test('parseImagesInputTag strips a malformed tag body without attaching images', () => {
  const text = 'prompt\n\n<images_input>\nnot json here\n</images_input>';
  const parsed = parseImagesInputTag(text);
  assert.equal(parsed.text, 'prompt');
  assert.deepEqual(parsed.imagePaths, []);
});

test('toImageAttachments maps paths to posix attachment records', () => {
  assert.deepEqual(toImageAttachments(['a\\b\\c.png', 'd/e.jpg']), [
    { path: 'a/b/c.png' },
    { path: 'd/e.jpg' },
  ]);
});

test('resolveImageMediaType prefers the mime type and falls back to the extension', () => {
  assert.equal(resolveImageMediaType({ path: 'x.bin', mimeType: 'image/webp' }), 'image/webp');
  assert.equal(resolveImageMediaType({ path: 'x.JPG' }), 'image/jpeg');
  assert.equal(resolveImageMediaType({ path: 'x.png' }), 'image/png');
  assert.equal(resolveImageMediaType({ path: 'x.unknown' }), null);
});

test('buildClaudeUserContent reads image bytes into base64 blocks', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-'));
  try {
    await writeFile(path.join(tempDir, 'shot.png'), PNG_BYTES);

    const content = await buildClaudeUserContent(
      'What is in this image?',
      [{ path: 'shot.png', mimeType: 'image/png' }],
      tempDir,
    );

    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: 'text', text: 'What is in this image?' });
    assert.equal(content[1].type, 'image');
    const imageBlock = content[1] as Extract<(typeof content)[number], { type: 'image' }>;
    assert.equal(imageBlock.source.type, 'base64');
    assert.equal(imageBlock.source.media_type, 'image/png');
    assert.equal(imageBlock.source.data, PNG_BYTES.toString('base64'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildClaudeUserContent skips unsupported types and unreadable files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-'));
  try {
    await writeFile(path.join(tempDir, 'vector.svg'), '<svg></svg>');

    const content = await buildClaudeUserContent(
      'prompt',
      [
        { path: 'vector.svg', mimeType: 'image/svg+xml' },
        { path: 'missing.png', mimeType: 'image/png' },
      ],
      tempDir,
    );

    // Only the text block survives; the prompt still goes through.
    assert.deepEqual(content, [{ type: 'text', text: 'prompt' }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildClaudeUserContent refuses symlinked images outside allowed roots', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-'));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-outside-'));
  try {
    const outsideFile = path.join(outsideDir, 'secret.png');
    await writeFile(outsideFile, PNG_BYTES);

    const linkPath = path.join(tempDir, 'linked-secret.png');
    if (!(await createSymlinkIfSupported(outsideFile, linkPath, 'file'))) {
      t.skip('Symlink creation is not supported in this environment');
      return;
    }

    const content = await buildClaudeUserContent(
      'prompt',
      [{ path: 'linked-secret.png', mimeType: 'image/png' }],
      tempDir,
    );

    assert.deepEqual(content, [{ type: 'text', text: 'prompt' }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('buildClaudeUserContent accepts images under a symlinked cwd', async (t) => {
  const realProjectDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-project-'));
  const linkParentDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-link-'));
  try {
    await writeFile(path.join(realProjectDir, 'shot.png'), PNG_BYTES);

    const linkCwd = path.join(linkParentDir, 'project-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    if (!(await createSymlinkIfSupported(realProjectDir, linkCwd, linkType))) {
      t.skip('Symlink creation is not supported in this environment');
      return;
    }

    const content = await buildClaudeUserContent(
      'prompt',
      [{ path: 'shot.png', mimeType: 'image/png' }],
      linkCwd,
    );

    assert.equal(content.length, 2);
    assert.equal(content[1].type, 'image');
    const imageBlock = content[1] as Extract<(typeof content)[number], { type: 'image' }>;
    assert.equal(imageBlock.source.data, PNG_BYTES.toString('base64'));
  } finally {
    await rm(linkParentDir, { recursive: true, force: true });
    await rm(realProjectDir, { recursive: true, force: true });
  }
});

test('buildCodexInputItems emits text plus absolute local_image paths', () => {
  const cwd = path.join(os.tmpdir(), 'codex-project');
  const items = buildCodexInputItems('Describe this image:', [{ path: '.cloudcli/assets/pic.jpg' }], cwd);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { type: 'text', text: 'Describe this image:' });
  assert.equal(items[1].type, 'local_image');
  const imageItem = items[1] as Extract<(typeof items)[number], { type: 'local_image' }>;
  assert.ok(path.isAbsolute(imageItem.path));
  assert.equal(imageItem.path, path.resolve(cwd, '.cloudcli/assets/pic.jpg'));
});

test('isAllowedImageSourcePath only accepts the upload store and the run cwd', () => {
  const cwd = path.join(os.tmpdir(), 'some-project');
  const uploadStore = path.join(os.homedir(), '.cloudcli', 'assets');

  assert.equal(isAllowedImageSourcePath(path.join(uploadStore, 'shot.png'), cwd), true);
  assert.equal(isAllowedImageSourcePath(path.join(cwd, 'docs', 'diagram.png'), cwd), true);

  assert.equal(isAllowedImageSourcePath(path.join(os.homedir(), '.ssh', 'id_rsa'), cwd), false);
  assert.equal(isAllowedImageSourcePath(path.join(cwd, '..', 'other-project', 'x.png'), cwd), false);
  // The roots themselves are directories, not readable image files.
  assert.equal(isAllowedImageSourcePath(cwd, cwd), false);
});

test('provider builders refuse descriptors outside the allowed roots', async () => {
  const cwd = path.join(os.tmpdir(), 'codex-project');
  const outsidePath = path.join(os.homedir(), '.ssh', 'id_rsa.png');

  const codexItems = buildCodexInputItems('prompt', [{ path: outsidePath }], cwd);
  assert.deepEqual(codexItems, [{ type: 'text', text: 'prompt' }]);

  const claudeContent = await buildClaudeUserContent(
    'prompt',
    [{ path: outsidePath, mimeType: 'image/png' }],
    cwd,
  );
  assert.deepEqual(claudeContent, [{ type: 'text', text: 'prompt' }]);
});

// ---------------------------
//----------------- TRUSTED PI IMAGE READER ------------
// Unique filename counter for upload-store fixtures created by these tests.
let storeFixtureSeq = 0;

function nextStoreFixtureName(tag: string, ext = 'png'): string {
  storeFixtureSeq += 1;
  return `vb-test-${process.pid}-${Date.now()}-${storeFixtureSeq}-${tag}.${ext}`;
}

async function writeAssetsFixture(tag: string, bytes: Buffer, ext = 'png'): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await mkdir(assetsDir, { recursive: true });
  const filePath = path.join(assetsDir, nextStoreFixtureName(tag, ext));
  await writeFile(filePath, bytes);
  return filePath;
}

test('readTrustedPiImages reads a store image into a Pi image payload', async () => {
  const filePath = await writeAssetsFixture('valid', PNG_BYTES);
  try {
    const result = await readTrustedPiImages([{ path: filePath, mimeType: 'image/png' }]);

    assert.equal(result.failures.length, 0);
    assert.equal(result.images.length, 1);
    assert.deepEqual(result.images[0], {
      type: 'image',
      data: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
    });
  } finally {
    await rm(filePath, { force: true });
  }
});

test('readTrustedPiImages detects JPEG/PNG/GIF/WebP from magic bytes, not filenames', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const gif = Buffer.from('GIF89a1234');
  const webp = Buffer.from('RIFF\x00\x00\x00\x00WEBPabc');
  const cases = [
    { tag: 'jpeg', ext: 'bin', bytes: jpeg, mimeType: 'image/jpeg' },
    { tag: 'png', ext: 'bin', bytes: PNG_BYTES, mimeType: 'image/png' },
    { tag: 'gif', ext: 'bin', bytes: gif, mimeType: 'image/gif' },
    { tag: 'webp', ext: 'bin', bytes: webp, mimeType: 'image/webp' },
  ];

  const filePaths: string[] = [];
  try {
    for (const c of cases) {
      filePaths.push(await writeAssetsFixture(c.tag, c.bytes, c.ext));
    }

    const result = await readTrustedPiImages(filePaths.map((p) => ({ path: p })));

    assert.equal(result.failures.length, 0);
    assert.deepEqual(
      result.images.map((i) => i.mimeType),
      cases.map((c) => c.mimeType),
    );
  } finally {
    for (const p of filePaths) {
      await rm(p, { force: true });
    }
  }
});

test('readTrustedPiImages rejects paths outside the upload store', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vb-outside-'));
  try {
    const outsidePath = path.join(tempDir, 'secret.png');
    await writeFile(outsidePath, PNG_BYTES);

    const result = await readTrustedPiImages([{ path: outsidePath, mimeType: 'image/png' }]);

    assert.equal(result.images.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].index, 0);
    assert.equal(result.failures[0].errorCode, 'IMAGE_UNSAFE');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readTrustedPiImages refuses symlinks that escape the upload store', async (t) => {
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'vb-symlink-outside-'));
  try {
    const outsideFile = path.join(outsideDir, 'secret.png');
    await writeFile(outsideFile, PNG_BYTES);

    const assetsDir = getGlobalImageAssetsDir();
    await mkdir(assetsDir, { recursive: true });
    const linkPath = path.join(assetsDir, nextStoreFixtureName('link'));
    if (!(await createSymlinkIfSupported(outsideFile, linkPath, 'file'))) {
      t.skip('Symlink creation is not supported in this environment');
      return;
    }

    try {
      const result = await readTrustedPiImages([{ path: linkPath, mimeType: 'image/png' }]);

      assert.equal(result.images.length, 0);
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0].index, 0);
      assert.equal(result.failures[0].errorCode, 'IMAGE_UNSAFE');
      // The escaped target's bytes must never surface in the payload.
      assert.ok(!JSON.stringify(result).includes(PNG_BYTES.toString('base64')));
    } finally {
      await rm(linkPath, { force: true });
    }
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('readTrustedPiImages reports missing files as IMAGE_UNREADABLE', async () => {
  const assetsDir = getGlobalImageAssetsDir();
  await mkdir(assetsDir, { recursive: true });
  const missingPath = path.join(assetsDir, nextStoreFixtureName('missing'));

  const result = await readTrustedPiImages([{ path: missingPath, mimeType: 'image/png' }]);

  assert.equal(result.images.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 0);
  assert.equal(result.failures[0].errorCode, 'IMAGE_UNREADABLE');
});

test('readTrustedPiImages rejects unsupported magic bytes', async () => {
  const filePath = await writeAssetsFixture('svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  try {
    const result = await readTrustedPiImages([{ path: filePath, mimeType: 'image/png' }]);

    assert.equal(result.images.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].index, 0);
    assert.equal(result.failures[0].errorCode, 'IMAGE_UNSUPPORTED');
  } finally {
    await rm(filePath, { force: true });
  }
});

test('readTrustedPiImages skips images over the per-image byte cap', async () => {
  const filePath = await writeAssetsFixture('big', PNG_BYTES);
  try {
    const result = await readTrustedPiImages([{ path: filePath }], { maxBytesPerImage: 10 });

    assert.equal(result.images.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].index, 0);
    assert.equal(result.failures[0].errorCode, 'IMAGE_TOO_LARGE');
  } finally {
    await rm(filePath, { force: true });
  }
});

test('readTrustedPiImages enforces the cumulative byte budget', async () => {
  const fileA = await writeAssetsFixture('total-a', PNG_BYTES);
  const fileB = await writeAssetsFixture('total-b', PNG_BYTES);
  try {
    const result = await readTrustedPiImages([{ path: fileA }, { path: fileB }], {
      maxTotalBytes: PNG_BYTES.length + 1,
    });

    assert.equal(result.images.length, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].index, 1);
    assert.equal(result.failures[0].errorCode, 'IMAGE_TOO_LARGE');
  } finally {
    await rm(fileA, { force: true });
    await rm(fileB, { force: true });
  }
});

test('readTrustedPiImages returns partial success for mixed valid and invalid images', async () => {
  const fileValidA = await writeAssetsFixture('mix-valid-a', PNG_BYTES);
  const fileSvg = await writeAssetsFixture('mix-svg', Buffer.from('<svg></svg>'));
  const fileValidB = await writeAssetsFixture('mix-valid-b', PNG_BYTES);
  try {
    const result = await readTrustedPiImages([
      { path: fileValidA },
      { path: path.join(os.tmpdir(), `vb-outside-${storeFixtureSeq + 1}.png`) },
      { path: fileSvg },
      { path: fileValidB },
    ]);

    assert.equal(result.images.length, 2);
    assert.equal(result.failures.length, 2);
    assert.deepEqual(result.failures[0], { index: 1, errorCode: 'IMAGE_UNSAFE', reason: '图片不在受信的全局上传目录内' });
    assert.deepEqual(result.failures[1], { index: 2, errorCode: 'IMAGE_UNSUPPORTED', reason: '仅支持 JPEG/PNG/GIF/WebP 图片' });
  } finally {
    await rm(fileValidA, { force: true });
    await rm(fileSvg, { force: true });
    await rm(fileValidB, { force: true });
  }
});

test('readTrustedPiImages uses cwd only for relative resolution, never as an allowed root', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vb-cwd-'));
  try {
    await writeFile(path.join(tempDir, 'shot.png'), PNG_BYTES);

    const result = await readTrustedPiImages([{ path: 'shot.png', mimeType: 'image/png' }], {
      cwd: tempDir,
    });

    assert.equal(result.images.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].index, 0);
    assert.equal(result.failures[0].errorCode, 'IMAGE_UNSAFE');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
