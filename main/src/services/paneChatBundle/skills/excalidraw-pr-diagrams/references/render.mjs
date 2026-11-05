#!/usr/bin/env node
// Render an .excalidraw file to PNG with the browser already on this machine (Chrome, Edge or Chromium).
// Usage: node render.mjs <file.excalidraw> [--out <file.png>] [--scale 2]
// Elements may be short skeletons; Excalidraw fills in the rest, and the full file is written to <name>.full.excalidraw.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const args = process.argv.slice(2), input = args.find(a => !a.startsWith('--'));
const opt = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
if (!input) { console.error('Usage: node render.mjs <file.excalidraw> [--out file.png] [--scale 2]'); process.exit(2); }
const base = input.replace(/\.excalidraw$/, ''), out = opt('out') ?? base + '.png', scale = Number(opt('scale') ?? 2);

const browsers = [process.env.BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ...['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'].map(n => `/usr/bin/${n}`)];
const browser = browsers.find(p => p && fs.existsSync(p));
if (!browser) { console.error('No Chrome, Edge or Chromium found. Set BROWSER_PATH to one.'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const elements = (data.elements ?? []).map(e => ({roughness: 0, fontFamily: 3, strokeWidth: 2, ...(e.type === 'rectangle' && {roundness: {type: 3}}), ...e,
  ...(e.label && {label: {fontFamily: 3, fontSize: 16, ...e.label}})}));
if (!elements.length) { console.error('No elements to render'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'excalidraw-render-'));
const chrome = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {stdio: 'ignore'});
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n'); i++) {
    if (i > 100) throw new Error('The browser did not start');
    await new Promise(r => setTimeout(r, 100));
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); };
  const send = (method, params = {}) => new Promise((ok, fail) => { pending.set(++id, m => m.error ? fail(new Error(m.error.message)) : ok(m.result)); ws.send(JSON.stringify({id, method, params})); });
  const script = `(async () => {
    const {exportToSvg, convertToExcalidrawElements} = await import('https://esm.sh/@excalidraw/excalidraw@0.18.0?bundle');
    const elements = ${JSON.stringify(elements)};
    const full = elements.every(e => e.seed) ? elements : convertToExcalidrawElements(elements, {regenerateIds: false});
    const svg = await exportToSvg({elements: full, appState: {viewBackgroundColor: '#ffffff', exportPadding: 40, ...${JSON.stringify(data.appState ?? {})}, exportBackground: true}, files: {}});
    document.body.style.margin = 0; document.body.replaceChildren(svg);
    const box = svg.getBoundingClientRect();
    return JSON.stringify({full, width: Math.ceil(box.width), height: Math.ceil(box.height)});
  })()`;
  const result = await send('Runtime.evaluate', {expression: script, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Render failed');
  const {full, width, height} = JSON.parse(result.result.value);
  await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: scale, mobile: false});
  const shot = await send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width, height, scale: 1}});
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  fs.writeFileSync(base + '.full.excalidraw', JSON.stringify({...data, elements: full}, null, 1));
  ws.close(); console.log(out);
} finally {
  const exited = new Promise(r => chrome.once('exit', r)); chrome.kill(); await exited;
  fs.rmSync(profile, {recursive: true, force: true, maxRetries: 5});
}
