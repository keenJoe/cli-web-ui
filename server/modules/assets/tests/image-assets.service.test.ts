import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  isAllowedImageMimeType,
  resolveAttachmentAssetFile,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';

const ASSETS_DIR = path.join(os.homedir(), '.cloudcli', 'assets');

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  assert.equal(isAllowedImageMimeType('image/svg+xml'), true);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('buildStoredImageRecords returns absolute posix paths in the assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('buildStoredAttachmentRecords preserves metadata for non-image files', () => {
  const records = buildStoredAttachmentRecords([
    {
      originalname: 'requirements.pdf',
      filename: '123-456-requirements.pdf',
      size: 2048,
      mimetype: 'application/pdf',
    },
  ]);

  assert.deepEqual(records[0], {
    name: 'requirements.pdf',
    path: `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-requirements.pdf`,
    size: 2048,
    mimeType: 'application/pdf',
  });
});

test('resolveImageAssetFile resolves plain filenames inside the assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png');
  assert.equal(resolved, path.join(path.resolve(ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile(''), null);
  assert.equal(resolveImageAssetFile('   '), null);
  assert.equal(resolveImageAssetFile('../auth.db'), null);
  assert.equal(resolveImageAssetFile('..'), null);
  assert.equal(resolveImageAssetFile('sub/dir.png'), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png'), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png'), null);
});

test('resolveAttachmentAssetFile uses the same direct-child boundary', () => {
  assert.equal(
    resolveAttachmentAssetFile('123-notes.txt'),
    path.join(path.resolve(ASSETS_DIR), '123-notes.txt'),
  );
  assert.equal(resolveAttachmentAssetFile('../notes.txt'), null);
});

// ---------------------------
//----------------- RAW-BYTE CONTENT HASH ------------
let hashFixtureSeq = 0;

function nextHashFixtureName(tag: string): string {
  hashFixtureSeq += 1;
  return `vb-hash-${process.pid}-${Date.now()}-${hashFixtureSeq}-${tag}.png`;
}

async function writeHashFixture(tag: string, bytes: Buffer): Promise<string> {
  await mkdir(ASSETS_DIR, { recursive: true });
  const filePath = path.join(ASSETS_DIR, nextHashFixtureName(tag));
  await writeFile(filePath, bytes);
  return filePath;
}

test('buildStoredImageRecords computes identical contentHash for identical bytes across filenames', async () => {
  const bytes = Buffer.from('raw-image-bytes-for-hash');
  const fileA = await writeHashFixture('a', bytes);
  const fileB = await writeHashFixture('b', bytes);
  try {
    const records = buildStoredImageRecords([
      { originalname: 'a.png', filename: path.basename(fileA), size: bytes.length, mimetype: 'image/png' },
      { originalname: 'b.png', filename: path.basename(fileB), size: bytes.length, mimetype: 'image/png' },
    ]);

    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(records[0].contentHash, expected);
    assert.equal(records[1].contentHash, expected);
    assert.equal(records[0].contentHash, records[1].contentHash);
    assert.match(records[0].contentHash!, /^[0-9a-f]{64}$/);
  } finally {
    await rm(fileA, { force: true });
    await rm(fileB, { force: true });
  }
});

test('buildStoredImageRecords produces different contentHash for different bytes', async () => {
  const bytesA = Buffer.from('bytes-a');
  const bytesB = Buffer.from('bytes-b');
  const fileA = await writeHashFixture('bytes-a', bytesA);
  const fileB = await writeHashFixture('bytes-b', bytesB);
  try {
    const records = buildStoredImageRecords([
      { originalname: 'a.png', filename: path.basename(fileA), size: bytesA.length, mimetype: 'image/png' },
      { originalname: 'b.png', filename: path.basename(fileB), size: bytesB.length, mimetype: 'image/png' },
    ]);

    assert.notEqual(records[0].contentHash, records[1].contentHash);
    assert.equal(records[0].contentHash, createHash('sha256').update(bytesA).digest('hex'));
    assert.equal(records[1].contentHash, createHash('sha256').update(bytesB).digest('hex'));
  } finally {
    await rm(fileA, { force: true });
    await rm(fileB, { force: true });
  }
});

test('buildStoredImageRecords omits contentHash when the file is unreadable', () => {
  const records = buildStoredImageRecords([
    {
      originalname: 'missing.png',
      filename: 'vb-hash-missing-nonexistent.png',
      size: 4,
      mimetype: 'image/png',
    },
  ]);

  assert.equal(records[0].contentHash, undefined);
  assert.deepEqual(Object.keys(records[0]).sort(), ['mimeType', 'name', 'path', 'size']);
});
