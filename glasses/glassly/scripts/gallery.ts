// The device gallery: every gallery screen (glasses/dev/galleryPages.ts) as Pane on Glassly draws
// it, once per Glassly device profile, at that profile's resolution, in one page for a desktop
// browser. A screen that breaks a profile's limit carries a red flag naming it.
//   pnpm --filter @pane/glasses-glassly gallery   → glasses/glassly/build/gallery.html
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { frameSvg, type FrameElement } from '../src/frameSvg.ts';
import { pinnedPackage } from './pinned.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'gallery.html');

type Element = FrameElement;
interface Profile { modelName: string; display?: { width?: number; height?: number; maxTextElements?: number; maxImageElements?: number; maxTextLines?: number; resolution?: { width: number; height: number } } | null }
interface GalleryPage { boxes: Array<{ kind: string }> }
interface Bundle {
  pages: Array<[string, GalleryPage]>;
  render(page: GalleryPage | undefined, profile: Profile): { tier: 'full' | 'glance'; elements: Element[]; textBoxes: number };
  textWidth(text: string): number;
}

/** The gallery screens and the Glassly renderer, bundled for Node (the screens import fixtures as `?raw` text). */
async function loadBundle(): Promise<Bundle> {
  const file = join(root, '.cache', 'gallery-bundle.mjs');
  await build({
    stdin: {
      contents: `
        import { galleryPages } from '../dev/galleryPages';
        import { ListFocus, renderPage } from './src/background/render';
        import { tierOf } from './src/background/tier';
        import { glanceText } from './src/background/glance';
        import { DemoSource } from '../src/demo';
        import { textWidth } from '../src/text';
        export const pages = galleryPages('http://127.0.0.1');
        export { textWidth };
        export function render(page, profile) {
          const tier = tierOf(profile);
          const textBoxes = page.boxes.filter((box) => box.kind !== 'image').length;
          if (tier.kind === 'glance') {
            const d = profile.display ?? {};
            const demo = new DemoSource(() => ({ cancel() {} }));
            return { tier: 'glance', textBoxes: 1, elements: [{ type: 'text', id: 'glance', box: { x: 0, y: 0, w: d.width ?? d.resolution?.width ?? 640, h: d.height ?? d.resolution?.height ?? 200 }, text: glanceText(demo) }] };
          }
          return { tier: 'full', textBoxes, elements: renderPage(page, new ListFocus().show(page), tier.budget) };
        }`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    nodePaths: [join(root, 'node_modules')],
    plugins: [{
      name: 'raw',
      setup(context) {
        context.onResolve({ filter: /\?raw$/ }, (args) => ({ path: join(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
        context.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
      },
    }],
    logLevel: 'error',
  });
  // SAFETY: the bundle above exports `pages`, `render` and `textWidth` with these shapes.
  return import(pathToFileURL(file).href) as Promise<Bundle>;
}

async function loadProfiles(): Promise<Array<[string, Profile]>> {
  const dir = join(await pinnedPackage('engine'), 'src', 'types', 'capabilities');
  const profiles: Array<[string, Profile]> = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'index.ts' && name !== 'none.ts')) {
    // SAFETY: each file under capabilities/ exports its device's Capabilities object and nothing else.
    const module = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, Profile>;
    const profile = Object.values(module).find((value) => Boolean(value.modelName));
    if (profile?.display) profiles.push([file.replace(/\.ts$/, ''), profile]);
  }
  return profiles;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LINE_H = 27;

/** What a screen breaks on a profile: elements over its pool, text past its box or its line limit. */
function flags(bundle: Bundle, rendered: ReturnType<Bundle['render']>, profile: Profile, g2Metrics: boolean): string[] {
  const display = profile.display ?? {};
  const found: string[] = [];
  const maxText = display.maxTextElements;
  if (maxText !== undefined && rendered.elements.length > maxText) found.push(`${rendered.elements.length} elements > maxTextElements ${maxText}`);
  for (const element of rendered.elements) {
    const lines = (element.text ?? '').split('\n');
    const fit = Math.floor(element.box.h / LINE_H) + 1;
    if (rendered.tier === 'full' && lines.length > fit) found.push(`${element.id}: ${lines.length} lines in a ${element.box.h} px box`);
    if (display.maxTextLines !== undefined && lines.length > display.maxTextLines) found.push(`${element.id}: ${lines.length} lines > maxTextLines ${display.maxTextLines}`);
    if (g2Metrics && lines.some((line) => bundle.textWidth(line) > element.box.w)) found.push(`${element.id}: a line wider than its box`);
  }
  return found;
}

function svg(rendered: ReturnType<Bundle['render']>, width: number, height: number): string {
  return frameSvg(rendered.elements, width, height).replace('<svg ', `<svg width="${width}" height="${height}" `);
}

async function main(): Promise<void> {
  const [bundle, profiles] = await Promise.all([loadBundle(), loadProfiles()]);
  const sections: string[] = [];
  let flagged = 0;
  for (const [name, profile] of profiles) {
    const display = profile.display ?? {};
    const width = display.width ?? display.resolution?.width ?? 640;
    const height = display.height ?? display.resolution?.height ?? 200;
    const g2 = name === 'even-realities-g2' || name === 'simulated-glasses';
    const cells = (bundle.render(bundle.pages[0]?.[1], profile).tier === 'glance' ? bundle.pages.slice(0, 1) : bundle.pages).map(([screen, page]) => {
      const rendered = bundle.render(page, profile);
      const found = flags(bundle, rendered, profile, g2);
      if (found.length) flagged += 1;
      const title = rendered.tier === 'glance' ? 'glance (every screen)' : screen;
      return `<figure><figcaption>${escape(title)}${found.map((flag) => `<span class="flag">${escape(flag)}</span>`).join('')}</figcaption>${svg(rendered, width, height)}</figure>`;
    });
    const tier = bundle.render(bundle.pages[0]?.[1], profile).tier;
    sections.push(`<section><h2>${escape(profile.modelName)} <small>${width}×${height} · ${tier === 'full' ? `full app · ${display.maxTextElements ?? '?'} text elements` : 'glance'}${g2 ? '' : ' · widths approximate'}</small></h2><div class="grid">${cells.join('')}</div></section>`);
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pane on Glassly · device gallery</title>
<style>
:root { color-scheme: light dark; --bg: #f6f6f6; --fg: #111; --muted: #666; --bad: #c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #eee; --muted: #999; --bad: #ff6b5e; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 32px; } small { color: var(--muted); font-weight: normal; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
figure { margin: 0; } figcaption { font-size: 12px; margin-bottom: 4px; } svg { width: 100%; height: auto; border-radius: 4px; }
.flag { display: block; color: var(--bad); }
</style></head><body><h1>Pane on Glassly · device gallery</h1>
<p>Each gallery screen as Pane's Glassly build sends it, per Glassly 0.4.0 device profile. Text is drawn in a system font; G2 widths use the G2 font's metrics. ${flagged} screens flagged.</p>
${sections.join('\n')}</body></html>`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`Wrote ${out} (${flagged} flagged)`);
}

await main();
