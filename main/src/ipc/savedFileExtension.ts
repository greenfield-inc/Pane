import path from 'node:path';

/**
 * The extension a pasted or dropped file is saved under: its own ("notes.txt" stays .txt), else the
 * MIME subtype ("image/png", as a pasted screenshot has no name), else png. Only short letters and digits.
 */
export function savedFileExtension(name: string, type: string): string {
  const own = path.posix.extname(path.posix.basename(name.replaceAll('\\', '/'))).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,10}$/.test(own)) return own;
  const subtype = type.split('/')[1]?.split('+')[0] ?? '';
  return /^[a-z0-9.-]{1,20}$/i.test(subtype) ? subtype : 'png';
}
