// Glassly packages read at a pinned version and checksum, without installing them: the CLI's
// manifest check and runtime guard (whose dependencies are newer than this repo's 7-day install
// floor) and the engine's device profiles (whose dependencies pull in React Native).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const PINNED = {
  cli: {
    tarball: 'https://registry.npmjs.org/@glassly/miniapp-cli/-/miniapp-cli-0.1.7.tgz',
    integrity: 'sha512-IM1IYF2AzgJ5lFsUFVaTcCeh0Cpq372upQAaeT7O+eZg0M1mnZbm5rRMhNnwNpFC9mpPCc8qsO/U9mdroGW65A==',
  },
  engine: {
    tarball: 'https://registry.npmjs.org/@glassly/engine/-/engine-0.4.0.tgz',
    integrity: 'sha512-85auM2Up3FXvQrw1VyCE8+I6P3yGD4mIQWa/IVcBMyHqAVqj+1CEcDCW0RnhgIfKByVNem2SXaNZ2mJ72Po0YA==',
  },
};

export type PinnedName = keyof typeof PINNED;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, 'node_modules', '.cache', 'pane-pinned');

/** Writes each regular file of a tar archive under `dir`. */
function untar(archive: Uint8Array, dir: string): void {
  const text = (start: number, length: number) => new TextDecoder().decode(archive.subarray(start, start + length)).replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= archive.length;) {
    const name = text(offset, 100);
    if (!name) break;
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = text(offset + 156, 1);
    const prefix = text(offset + 345, 155);
    const path = normalize(prefix ? `${prefix}/${name}` : name);
    const body = offset + 512;
    if ((type === '0' || type === '') && !path.startsWith('..')) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, archive.subarray(body, body + size));
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
}

/** The unpacked `package/` folder of a pinned Glassly package, downloaded once and checked. */
export async function pinnedPackage(name: PinnedName): Promise<string> {
  const { tarball, integrity } = PINNED[name];
  const dir = join(cache, integrity.slice(7, 23).replace(/[^a-zA-Z0-9]/g, '_'));
  const done = join(dir, '.complete');
  if (existsSync(done)) return join(dir, 'package');
  const response = await fetch(tarball);
  if (!response.ok) throw new Error(`Downloading ${tarball} failed with HTTP ${response.status}. Check the network, then build again.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (digest !== integrity) throw new Error(`${tarball} does not match its pinned checksum (got ${digest}). Nothing was unpacked; check PINNED in glasses/glassly/scripts/pinned.ts.`);
  untar(gunzipSync(bytes), dir);
  writeFileSync(done, integrity);
  return join(dir, 'package');
}

/** A file inside a pinned package, as text. */
export async function pinnedFile(name: PinnedName, path: string): Promise<string> {
  return readFileSync(join(await pinnedPackage(name), path), 'utf8');
}
