import path from 'path';

/** Below the common 255-byte limit on a name (ext4, APFS), counted in encoded bytes. */
const MAX_BYTES = 200;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** The longest start of `text` that fits in `bytes`, never splitting a character. */
function fitBytes(text: string, bytes: number): string {
  let fitted = '';
  let used = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > bytes) break;
    fitted += char;
  }
  return fitted;
}

/**
 * The name a file dropped into a chat keeps on the host (D-162): its own base name, with
 * characters a file system refuses replaced, trimmed the way Windows trims names, shortened
 * by bytes (keeping the extension) when very long, and with a Windows reserved base name
 * prefixed, since the host may be any platform. It never leads out of its folder.
 */
export function attachmentFileName(original: string): string {
  // A name from another platform may use either separator; keep only the last part.
  const base = original.split(/[\\/]/).pop() ?? '';
  // Control characters and the ones Windows refuses become "_".
  const refused = (char: string) => char.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(char);
  let name = [...base].map(char => refused(char) ? '_' : char).join('').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') return 'file';
  if (Buffer.byteLength(name) > MAX_BYTES) {
    const extension = fitBytes(path.extname(name), 16);
    name = `${fitBytes(name, MAX_BYTES - Buffer.byteLength(extension)).replace(/[. ]+$/, '')}${extension}`;
  }
  // Windows reserves CON, NUL and the like whatever follows the first dot.
  if (WINDOWS_RESERVED.test(name.split('.')[0])) name = `_${name}`;
  return name;
}
