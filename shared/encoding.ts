/**
 * Repairs filenames mangled by a misparse of raw bytes as latin1.
 *
 * Uploaded filenames can arrive at multer's `originalname` corrupted: the
 * true Chinese name was encoded as GBK bytes, each byte then carried as one
 * latin1 character (every code point <= U+00FF), so a name like `璐珏 1Agent`
 * reads as mojibake `è´çå 1Agent`.
 *
 * The repair is intentionally conservative. It only rewrites names whose
 * every code point fits in one byte, then requires a strict GB18030 decode to
 * yield at least two CJK characters — a strong signature of the misparse
 * above. Everything else (pure ASCII, real Chinese, latin1 names, emoji) is
 * returned unchanged, and the function is idempotent, so it can be applied at
 * every layer without double-transforming.
 */
export function repairMojibakeName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    return name;
  }
  let allByteSized = true;
  for (const ch of name) {
    if (ch.codePointAt(0)! > 0xff) {
      allByteSized = false;
      break;
    }
  }
  if (!allByteSized) {
    return name;
  }

  const bytes = new Uint8Array([...name].length);
  let index = 0;
  for (const ch of name) {
    bytes[index++] = ch.codePointAt(0)! & 0xff;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  } catch {
    return name;
  }

  let cjkCount = 0;
  for (const ch of decoded) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      cjkCount += 1;
    }
  }
  return cjkCount >= 2 ? decoded : name;
}
