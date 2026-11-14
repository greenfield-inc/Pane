// Builds the Glassly miniapp into dist/: the background as one classic script and the phone
// screen as a page. Runs under Node (`pnpm --filter @pane/glasses-glassly build`) and under Bun
// (`glassly dev` runs `bun run build.ts`). Every repo module the background bundles, the shared
// glasses core included, goes through Glassly's own runtime guard, which Glassly applies only to
// a project's src/ folder; the manifest goes through Glassly's own check.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { JsonValue } from '../../shared/validation/boundaryDecoder.ts';
import { pinnedPackage } from './scripts/pinned.ts';

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, '..', '..');
const dist = join(root, 'dist');

/** miniapp.json as read from disk; Glassly's own check below decides whether it is valid. */
type Manifest = Record<string, JsonValue>;
interface Finding { api: string; line: number; column: number; replacement: string }
interface GlasslyChecks {
  findUnsupportedBackgroundApis(source: string, fileName: string): Finding[];
  validateManifest(manifest: Manifest): { valid: boolean; errors: string[] };
}

/** Glassly's runtime guard and manifest check, from the pinned CLI source, bundled for Node. */
export async function glasslyChecks(): Promise<GlasslyChecks> {
  const cli = await pinnedPackage('cli');
  const out = join(root, '.cache', 'glassly-checks.mjs');
  await build({
    stdin: {
      contents: `export { findUnsupportedBackgroundApis } from ${JSON.stringify(join(cli, 'src', 'build-helpers.ts'))};\nexport { validateManifest } from ${JSON.stringify(join(cli, 'src', 'manifest.ts'))};`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    external: ['typescript', '@glassly/miniapp', '@glassly/miniapp/*'],
    logLevel: 'error',
  });
  // SAFETY: the bundle above exports exactly these two functions from Glassly's CLI source.
  return import(pathToFileURL(out).href) as Promise<GlasslyChecks>;
}

/**
 * The repo modules in a bundle, each with the code esbuild kept of it. Unminified esbuild output
 * names each module in a `// path` line before its code, so tree-shaken code is never judged.
 */
export function bundledModules(output: string): Array<{ path: string; code: string }> {
  const marks = [...output.matchAll(/^[ \t]*\/\/ (\S+\.(?:ts|js|mjs))$/gm)];
  return marks.map((mark, index) => ({
    path: mark[1] ?? '',
    code: output.slice((mark.index ?? 0) + mark[0].length, marks[index + 1]?.index ?? output.length),
  })).filter((module) => !module.path.includes('node_modules'));
}

export async function buildMiniapp(): Promise<void> {
  const checks = await glasslyChecks();
  const manifest: Manifest = JSON.parse(readFileSync(join(root, 'miniapp.json'), 'utf8'));
  const { valid, errors } = checks.validateManifest(manifest);
  if (!valid) throw new Error(`miniapp.json fails Glassly's check:\n  ${errors.join('\n  ')}`);

  rmSync(dist, { recursive: true, force: true });
  const findings: string[] = [];
  const define = { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') };
  await build({
    entryPoints: [join(root, 'src', 'background', 'index.ts')],
    outfile: join(dist, 'background', 'index.js'),
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    target: 'es2020',
    // The shared core imports packages from glasses/; a checkout with only this folder installed finds them here.
    nodePaths: [join(root, 'node_modules')],
    define,
    logLevel: 'error',
  });
  for (const module of bundledModules(readFileSync(join(dist, 'background', 'index.js'), 'utf8'))) {
    for (const finding of checks.findUnsupportedBackgroundApis(module.code, `${module.path}.js`)) {
      findings.push(`${module.path} uses ${finding.api}: ${finding.replacement}`);
    }
  }
  if (findings.length) throw new Error(`The background uses APIs Glassly's runtime doesn't have:\n  ${findings.join('\n  ')}`);

  await build({
    entryPoints: [join(root, 'src', 'ui', 'main.ts')],
    outfile: join(dist, 'ui', 'main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    nodePaths: [join(root, 'node_modules')],
    define,
    logLevel: 'error',
  });
  mkdirSync(join(dist, 'ui'), { recursive: true });
  copyFileSync(join(root, 'src', 'ui', 'index.html'), join(dist, 'ui', 'index.html'));
}

// SAFETY: Bun sets `import.meta.main`; Node leaves it undefined, so the argv check decides there.
const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]);
if (isMain) {
  buildMiniapp().then(() => console.log(`Built ${relative(process.cwd(), dist) || dist}`), (error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
