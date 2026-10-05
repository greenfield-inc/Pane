import { promises as fs } from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/** One action our layer took, with the target window as it looked afterwards. */
export interface ComputerUseStep {
  index: number;
  action: string;
  args: JsonObject;
  result: JsonValue;
  /** Base64 PNG without a `data:` prefix; missing when the capture failed. */
  screenshotPng?: string;
  at: string;
}

/** What a script reports; `index` and `at` default to the arrival order and time. */
export const reportedStepSchema = boundary.object({
  index: boundary.optional(boundary.number),
  action: boundary.nonEmptyString,
  args: boundary.optional(boundary.jsonObject),
  result: boundary.optional(boundary.json),
  screenshotPng: boundary.optional(boundary.string),
  at: boundary.optional(boundary.string),
});

const INDEX_FILE = 'steps.jsonl';
const REPLAY_FILE = 'replay.html';

const savedStepSchema = boundary.object({
  run: boundary.string,
  index: boundary.number,
  action: boundary.string,
  args: boundary.jsonObject,
  result: boundary.json,
  at: boundary.string,
  screenshot: boundary.optional(boundary.string),
});
type SavedStep = ReturnType<typeof savedStepSchema.decode>;

/**
 * Saves a step into `dir`: its screenshot as `steps/<run>-<index>.png` and a line in `steps.jsonl`.
 * Steps of one run must be saved in order; runs may save concurrently.
 */
export async function saveStep(dir: string, run: string, step: ComputerUseStep): Promise<void> {
  let screenshot: string | undefined;
  if (step.screenshotPng) {
    screenshot = `steps/${run}-${String(step.index).padStart(4, '0')}.png`;
    await fs.mkdir(path.join(dir, 'steps'), { recursive: true });
    await fs.writeFile(path.join(dir, screenshot), Buffer.from(step.screenshotPng, 'base64'));
  }
  const saved: SavedStep = { run, index: step.index, action: step.action, args: step.args, result: step.result, at: step.at, screenshot };
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, INDEX_FILE), `${JSON.stringify(saved)}\n`);
}

/** Rebuilds `replay.html` in `dir` from every saved step and returns its path. */
export async function writeReplay(dir: string): Promise<string> {
  const index = await fs.readFile(path.join(dir, INDEX_FILE), 'utf8').catch(() => '');
  const saved = index.split('\n').filter(Boolean).map((line) => decodeBoundary(JSON.parse(line), savedStepSchema));
  const steps = await Promise.all(saved.map(async ({ screenshot, ...step }) => ({
    ...step,
    image: screenshot ? (await fs.readFile(path.join(dir, screenshot)).catch(() => undefined))?.toString('base64') ?? null : null,
  })));
  const target = path.join(dir, REPLAY_FILE);
  // Write beside and rename, so an open tab never reads half a page.
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, renderReplay(steps));
  await fs.rename(temp, target);
  return target;
}

interface ReplayStep {
  run: string;
  index: number;
  action: string;
  args: JsonObject;
  result: JsonValue;
  at: string;
  image: string | null;
}

/** One page with no network access: the steps and their screenshots are inlined. */
function renderReplay(steps: ReplayStep[]): string {
  // `<` escaped so no value can close the script element.
  const data = JSON.stringify(steps).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Computer use replay</title>
<style>
:root { --bg: #ffffff; --panel: #f4f4f5; --text: #18181b; --muted: #71717a; --border: #e4e4e7; --accent: #2563eb; --accent-text: #ffffff; --error: #dc2626; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #18181b; --panel: #232327; --text: #f4f4f5; --muted: #a1a1aa; --border: #3f3f46; --accent: #60a5fa; --accent-text: #0b1220; --error: #f87171; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); display: grid; grid-template-columns: 220px minmax(0, 1fr); height: 100vh; }
nav { border-right: 1px solid var(--border); overflow-y: auto; background: var(--panel); }
nav h1 { font-size: 13px; margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--border); }
nav h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0; padding: 12px 14px 4px; }
nav button { display: flex; gap: 8px; width: 100%; text-align: left; border: 0; background: none; color: inherit; font: inherit; padding: 5px 14px; cursor: pointer; }
nav button:hover { background: var(--border); }
nav button[aria-current="true"], nav button[aria-current="true"] .failed { background: var(--accent); color: var(--accent-text); }
nav .n { color: inherit; opacity: .65; min-width: 2.2em; font-variant-numeric: tabular-nums; }
main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
header { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
header strong { font-size: 15px; }
header .at { color: var(--muted); margin-left: auto; font-variant-numeric: tabular-nums; }
header button { border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer; }
header button:disabled { opacity: .4; cursor: default; }
.shot { flex: 1; min-height: 0; padding: 16px; display: flex; align-items: center; justify-content: center; }
.shot img { max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid var(--border); border-radius: 6px; }
.shot p { color: var(--muted); }
.detail { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 16px 16px; max-height: 35vh; overflow: auto; }
.detail h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 4px; }
.detail pre { margin: 0; padding: 8px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.failed { color: var(--error); }
.empty { padding: 24px; color: var(--muted); }
@media (max-width: 700px) { body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); } nav { max-height: 30vh; } nav { border-right: 0; border-bottom: 1px solid var(--border); } .detail { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<nav aria-label="Steps"><h1>Computer use replay</h1><div id="list"></div></nav>
<main id="view"></main>
<script id="steps" type="application/json">${data}</script>
<script>
const steps = JSON.parse(document.getElementById('steps').textContent);
const list = document.getElementById('list');
const view = document.getElementById('view');
const el = (tag, props, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
const pretty = (value) => value === undefined ? '' : JSON.stringify(value, null, 2);
const failed = (result) => !!result && typeof result === 'object' && !Array.isArray(result) && (result.ok === false || 'error' in result);
const time = (at) => { const d = new Date(at); return isNaN(d) ? at : d.toLocaleTimeString(); };
let current = 0;
const buttons = [];
let lastRun = null;
let runCount = 0;
steps.forEach((step, i) => {
  if (step.run !== lastRun) {
    lastRun = step.run;
    runCount += 1;
    list.append(el('h2', { textContent: 'Run ' + runCount + ' · ' + time(step.at) }));
  }
  const button = el('button', { type: 'button', onclick: () => show(i) }, el('span', { className: 'n', textContent: String(i + 1) }), el('span', { textContent: step.action, className: failed(step.result) ? 'failed' : '' }));
  buttons.push(button);
  list.append(button);
});
function show(i) {
  if (!steps.length) { view.replaceChildren(el('p', { className: 'empty', textContent: 'No steps yet.' })); return; }
  current = Math.max(0, Math.min(steps.length - 1, i));
  const step = steps[current];
  buttons.forEach((b, j) => b.setAttribute('aria-current', String(j === current)));
  buttons[current].scrollIntoView({ block: 'nearest' });
  const prev = el('button', { type: 'button', textContent: '← Prev', disabled: current === 0, onclick: () => show(current - 1) });
  const next = el('button', { type: 'button', textContent: 'Next →', disabled: current === steps.length - 1, onclick: () => show(current + 1) });
  view.replaceChildren(
    el('header', {}, prev, next, el('strong', { textContent: 'Step ' + (current + 1) + ' of ' + steps.length + ': ' + step.action, className: failed(step.result) ? 'failed' : '' }), el('span', { className: 'at', textContent: time(step.at) })),
    el('div', { className: 'shot' }, step.image ? el('img', { src: 'data:image/png;base64,' + step.image, alt: 'Window after ' + step.action }) : el('p', { textContent: 'No screenshot for this step.' })),
    el('div', { className: 'detail' },
      el('div', {}, el('h3', { textContent: 'Arguments' }), el('pre', { textContent: pretty(step.args) })),
      el('div', {}, el('h3', { textContent: 'Result' }), el('pre', { textContent: pretty(step.result) }))),
  );
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); show(current + 1); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); show(current - 1); }
});
// Opens on the latest run. The URL stays fixed so Pane can find and reload this tab.
show(Math.max(0, steps.findIndex((step) => step.run === lastRun)));
</script>
</body>
</html>
`;
}
