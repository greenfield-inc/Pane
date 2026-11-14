// Builds the Glassly miniapp and packs it as Glassly's own `glassly pack` does: dist/ with
// miniapp.json and icon.png at the root, zipped to build/<packageName>-<version>.zip. Raise
// "version" in miniapp.json before each store release; Glassly keeps installs per version.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { buildMiniapp } from '../build.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

export async function packMiniapp(): Promise<string> {
  await buildMiniapp();
  const manifest = JSON.parse(readFileSync(join(root, 'miniapp.json'), 'utf8')) as { packageName: string; version: string };
  const zip = new JSZip();
  const dist = join(root, 'dist');
  for (const path of files(dist)) zip.file(relative(dist, path).split('\\').join('/'), readFileSync(path));
  zip.file('miniapp.json', readFileSync(join(root, 'miniapp.json')));
  zip.file('icon.png', readFileSync(join(root, 'icon.png')));
  const out = join(root, 'build', `${manifest.packageName}-${manifest.version}.zip`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  return out;
}

const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]);
if (isMain) {
  packMiniapp().then((out) => console.log(`Packed ${relative(process.cwd(), out)}`), (error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
