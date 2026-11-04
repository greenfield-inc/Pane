import path from 'path';

const MAX_LENGTH = 120;

/**
 * The name a file dropped into a chat keeps on the host (D-162): its own base name, with
 * characters a file system refuses replaced, trimmed the way Windows trims names, and
 * shortened (keeping the extension) when very long. It never leads out of its folder.
 */
export function attachmentFileName(original: string): string {
  // A name from another platform may use either separator; keep only the last part.
  const base = original.split(/[\\/]/).pop() ?? '';
  // Control characters and the ones Windows refuses become "_".
  const refused = (char: string) => char.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(char);
  let name = [...base].map(char => refused(char) ? '_' : char).join('').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') return 'file';
  if (name.length > MAX_LENGTH) {
    const extension = path.extname(name).slice(0, 16);
    name = `${name.slice(0, MAX_LENGTH - extension.length)}${extension}`;
  }
  return name;
}
