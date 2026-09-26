// Renders the App Store screenshots from template.html, shots.json and the
// simulator captures in captures/<device>/, then a contact sheet.
// Usage: node native/store/screenshots-src/render.mjs [--only 01-panes]
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'screenshots', 'en-US');
const shots = JSON.parse(await readFile(path.join(here, 'shots.json'), 'utf8'));
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const DEVICES = {
  iphone: { width: 1320, height: 2868 },
  ipad: { width: 2064, height: 2752 },
};

const exists = file => access(file).then(() => true, () => false);

// Chrome writes untagged 8-bit RGB PNGs. Insert an sRGB chunk right after IHDR
// (8-byte signature + 25-byte IHDR chunk) so the color space is explicit.
function tagSrgb(png) {
  const chunk = Buffer.alloc(13);
  chunk.writeUInt32BE(1, 0);
  chunk.write('sRGB', 4, 'ascii');
  chunk[8] = 0; // perceptual rendering intent
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 9)), 9);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

// System Chrome avoids downloading a Playwright browser; set PANE_STORE_CHROMIUM to use another binary.
const browser = await chromium.launch(process.env.PANE_STORE_CHROMIUM
  ? { executablePath: process.env.PANE_STORE_CHROMIUM }
  : { channel: 'chrome' });
await mkdir(outDir, { recursive: true });

const rendered = { iphone: [], ipad: [] };
for (const [device, size] of Object.entries(DEVICES)) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  for (const [index, shot] of shots.entries()) {
    if (only && shot.id !== only) continue;
    if (!(await exists(path.join(here, 'captures', device, shot.capture)))) {
      console.warn(`skip ${device}/${shot.id}: no captures/${device}/${shot.capture}`);
      continue;
    }
    await page.goto(pathToFileURL(path.join(here, 'template.html')).href);
    await page.evaluate(([s, d, i]) => window.renderShot(s, d, i), [shot, device, index]);
    const file = path.join(outDir, `${device}-${shot.id}.png`);
    // Chrome writes 8-bit RGB PNGs with no alpha channel, as App Store Connect requires.
    await writeFile(file, tagSrgb(await page.screenshot({ type: 'png' })));
    rendered[device].push(file);
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
  await page.close();
}

// Contact sheet for PR review. It lives outside screenshots/ so deliver never uploads it.
if (!only) {
  const rows = Object.entries(rendered).filter(([, files]) => files.length);
  const html = `<body style="margin:0;padding:40px;width:max-content;background:#18181b;font:600 28px system-ui;color:#fafafa">${rows.map(([device, files]) => `
    <div style="margin-bottom:16px">${device === 'iphone' ? 'iPhone 6.9" (1320x2868)' : 'iPad 13" (2064x2752)'}</div>
    <div style="display:flex;gap:24px;margin-bottom:48px">${files.map(f => `<img src="${pathToFileURL(f).href}" style="height:${device === 'iphone' ? 900 : 700}px;flex-shrink:0;border-radius:12px">`).join('')}</div>`).join('')}</body>`;
  // Chrome loads file:// images only into a file:// page, so the sheet goes through a temp file.
  const sheetHtml = path.join(here, '.contact-sheet.html');
  await writeFile(sheetHtml, html);
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  await page.goto(pathToFileURL(sheetHtml).href);
  await page.waitForFunction(() => [...document.images].every(img => img.complete));
  const box = await page.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
  await page.setViewportSize(box);
  const sheet = path.join(here, 'contact-sheet.png');
  await writeFile(sheet, await page.screenshot({ type: 'png', fullPage: true }));
  await rm(sheetHtml);
  console.log(`wrote ${path.relative(process.cwd(), sheet)}`);
}

await browser.close();
