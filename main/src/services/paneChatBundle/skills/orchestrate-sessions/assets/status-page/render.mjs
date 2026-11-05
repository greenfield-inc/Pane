// Renders the Session status page from a status JSON file (references/status-board.md).
// usage: node render.mjs <status.json> <out.html>
// Diagrams are drawn with rough.js at render time; the page itself has no script and fetches nothing.
// rough.mjs and the Inter font are vendored beside this file, so it needs nothing but Node.
// Pane's copy adds, and a refresh from Agent Farm keeps: the `.qid:empty` and narrow `.qq` CSS (Needs-you rows in the
// 359 px Overview sidebar); every link through href(); numeric counts; an allow-listed item state; a script-src 'none' CSP. example-status.json uses Pane's role and plan names.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rough from './rough.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node render.mjs <status.json> <out.html>'); process.exit(2); }
const d = { session: {}, needs: [], items: [], done: [], decisions: [], sources: [], links: [], ...JSON.parse(fs.readFileSync(inPath, 'utf8')) };
const g = rough.generator();
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// `next` and `settings` may carry <b>, <code> and <a href> links; everything else in them is escaped.
const SAFE_HREF = /^(https?:|file:|pane:|#|\.{0,2}\/|[\w.-]+(\/|\.html|$))/i;
const rich = s => esc(s)
  .replace(/&lt;(\/?)(b|code)>/g, '<$1$2>')
  .replace(/&lt;a href=&quot;([^"&<>]*(?:&amp;[^"&<>]*)*)&quot;>(.*?)&lt;\/a>/g, (m, url, text) => SAFE_HREF.test(url.replace(/&amp;/g, '&')) ? `<a href="${url}">${text}</a>` : text);

// ---------- diagrams ----------
const COLOR = { retried: 'var(--bad)', done: 'var(--ok)', now: 'var(--run)', need: 'var(--warn)', blocked: 'var(--bad)', failed: 'var(--bad)', todo: 'var(--todo)', skipped: 'var(--todo)' };
const WASH = { now: 'var(--run-wash)', need: 'var(--warn-wash)', blocked: 'var(--bad-wash)', failed: 'var(--bad-wash)' };
const HOT = new Set(['now', 'need', 'blocked', 'failed']);
const DASHED = new Set(['todo', 'skipped']);
let seed = 7;
const opts = (x = {}) => ({ roughness: 1.2, bowing: 1.1, seed: seed++, stroke: 'x', ...x });
function draw(out, dr, stroke, fill, dash) {
  for (const p of g.toPaths(dr)) {
    const f = p.fill && p.fill !== 'none';
    out.push(`<path d="${p.d.replace(/(\d+\.\d)\d+/g, '$1')}" fill="${f ? fill : 'none'}" stroke="${f ? 'none' : stroke}" stroke-width="${p.strokeWidth}"${dash && !f ? ' stroke-dasharray="6 5"' : ''} stroke-linecap="round"/>`);
  }
}
const tcls = st => (HOT.has(st.state) ? 'on ' + st.state : DASHED.has(st.state) ? 'mut' : st.state === 'retried' ? 'failed' : '');
function arrow(out, x1, y1, x2, y2, next) {
  const c = COLOR[next.state], dash = DASHED.has(next.state);
  draw(out, g.line(x1, y1, x2, y2, opts({ strokeWidth: 2 })), c, null, dash);
  const head = x1 === x2 ? [[x2 - 6, y2 - 8], [x2, y2], [x2 + 6, y2 - 8]] : [[x2 - 9, y2 - 6], [x2, y2], [x2 - 9, y2 + 6]];
  draw(out, g.linearPath(head, opts({ roughness: 0.8, strokeWidth: 2 })), c);
}
function boxesSvg(spec) {
  const s = spec.steps, n = s.length;
  const box = (out, st, x, y, w, h) => {
    draw(out, g.rectangle(x, y, w, h, opts({ strokeWidth: HOT.has(st.state) ? 2.4 : 1.6, ...(HOT.has(st.state) ? { fill: 'x', fillStyle: 'solid' } : {}) })), COLOR[st.state], WASH[st.state], DASHED.has(st.state));
    const label = st.label + (st.state === 'done' ? ' ✓' : ''), fits = t => t.length * 7.6 <= w - 14;
    let lines = [label];
    if (!fits(label)) { const words = label.split(' '); let best = null;
      for (let k = 1; k < words.length; k++) { const a = words.slice(0, k).join(' '), b = words.slice(k).join(' '), m = Math.max(a.length, b.length); if (!best || m < best.m) best = { a, b, m }; }
      if (best) lines = [best.a, best.b]; }
    const longest = Math.max(...lines.map(l => l.length)), fs = Math.min(14, Math.max(10, (w - 14) / (longest * 0.55)));
    const y0 = y + h / 2 + fs * 0.36 - (lines.length - 1) * fs * 0.6;
    out.push(`<text x="${x + w / 2}" y="${y0}" text-anchor="middle" class="${tcls(st)}" style="font-size:${fs.toFixed(1)}px">${lines.map((l, i) => `<tspan x="${x + w / 2}" dy="${i ? fs * 1.2 : 0}">${esc(l)}</tspan>`).join('')}</text>`);
  };
  const wide = [], gap = 30, bw = (852 - gap * (n - 1)) / n;
  s.forEach((st, i) => {
    const x = 4 + i * (bw + gap), big = HOT.has(st.state);
    box(wide, st, x, big ? 26 : 30, bw, big ? 56 : 48);
    if (st.tag) wide.push(`<text x="${x + bw / 2}" y="16" text-anchor="middle" class="tag" style="fill:${COLOR[st.state]}">${esc(st.tag)}</text>`);
    if (i < n - 1) arrow(wide, x + bw + 3, 54, x + bw + gap - 4, 54, s[i + 1]);
  });
  const tall = []; let y = 6;
  s.forEach((st, i) => {
    box(tall, st, 6, y, 236, 44);
    if (st.tag) tall.push(`<text x="250" y="${y + 26}" class="tag" style="fill:${COLOR[st.state]}">◀ ${esc(st.tag.split('·')[0].trim())}</text>`);
    y += 44;
    if (i < n - 1) { arrow(tall, 124, y + 3, 124, y + 22, s[i + 1]); y += 26; }
  });
  const tagW = Math.max(0, ...s.filter(st => st.tag).map(st => (st.tag.split('·')[0].trim().length + 2) * 7.5));
  return [{ w: 860, h: 88, body: wide }, { w: Math.max(310, 250 + tagW), h: y + 6, body: tall }];
}
function dot(out, st, x, y, r = 7) {
  const c = COLOR[st.state], hot = HOT.has(st.state);
  if (DASHED.has(st.state)) { out.push(`<circle cx="${x}" cy="${y}" r="${r - 1.5}" fill="var(--paper)" stroke="${c}" stroke-width="2"/>`); return; }
  if (hot) out.push(`<circle cx="${x}" cy="${y}" r="${r + 7}" fill="${WASH[st.state]}"/>`);
  out.push(`<circle cx="${x}" cy="${y}" r="${hot ? r + 1.5 : r}" fill="${c}"/>`);
  draw(out, g.circle(x, y, (hot ? r + 1.5 : r) * 2 + 3, opts({ roughness: 0.5, bowing: 0, strokeWidth: 1.4 })), c);
  if (['failed', 'blocked', 'retried'].includes(st.state)) out.push(`<path d="M${x - 3.5} ${y - 3.5}L${x + 3.5} ${y + 3.5}M${x + 3.5} ${y - 3.5}L${x - 3.5} ${y + 3.5}" stroke="var(--paper)" stroke-width="2.2" stroke-linecap="round"/>`);
  else if (st.state === 'need') out.push(`<text x="${x}" y="${y + 4}" text-anchor="middle" class="bang">!</text>`);
  else if (st.state === 'done') out.push(`<path d="M${x - 3} ${y}l2.2 2.4 4-4.6" fill="none" stroke="var(--paper)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);
}
function railLine(out, s, xs, y, gapR) {
  s.forEach((st, i) => { if (i < s.length - 1) draw(out, g.line(xs[i] + gapR, y, xs[i + 1] - gapR, y, opts({ strokeWidth: 2, roughness: 0.6, bowing: 0.6 })), COLOR[s[i + 1].state], null, DASHED.has(s[i + 1].state)); });
}
function railSvg(spec) {
  const s = spec.steps, n = s.length;
  const W = 860, pad = 52, spacing = n > 1 ? (W - 2 * pad) / (n - 1) : W;
  const widthOf = st => st.label.length * 7.2 + 8;
  const stagger = s.some((st, i) => i < n - 1 && (widthOf(st) + widthOf(s[i + 1])) / 2 > spacing);
  const y = stagger ? 36 : 22, xs = s.map((_, i) => (n === 1 ? W / 2 : pad + i * spacing));
  const wide = [];
  railLine(wide, s, xs, y, 12);
  s.forEach((st, i) => { dot(wide, st, xs[i], y); const up = stagger && i % 2 === 1;
    wide.push(`<text x="${xs[i]}" y="${up ? y - 20 : y + 36}" text-anchor="middle" class="${tcls(st)}">${esc(st.label)}</text>`); });
  const NW = 400, np = 16, ny = 18, nxs = s.map((_, i) => (n === 1 ? NW / 2 : np + i * (NW - 2 * np) / (n - 1)));
  const tall = [];
  railLine(tall, s, nxs, ny, 10);
  s.forEach((st, i) => dot(tall, st, nxs[i], ny, 6));
  return [{ w: W, h: stagger ? 82 : 68, body: wide }, { w: NW, h: 36, body: tall }];
}
function railNow(spec) {
  const s = spec.steps, i = s.findIndex(st => HOT.has(st.state));
  const cur = i >= 0 ? i : Math.max(0, s.findLastIndex(st => st.state === 'done'));
  const st = s[cur], next = s.slice(cur + 1).find(x => DASHED.has(x.state));
  return `<p class="railnow">Step ${cur + 1} of ${s.length} · ${esc(st.label)}${next ? ` → ${esc(next.label)}` : ''}</p>`;
}
function diagram(spec, kind, extraClass = '') {
  const [wide, tall] = (kind === 'rail' ? railSvg : boxesSvg)(spec);
  const aria = esc(spec.steps.map(s => `${s.label}: ${s.state}`).join(', '));
  const svg = (v, cls) => `<svg class="${cls}" viewBox="0 0 ${v.w} ${v.h}" role="img" aria-label="${aria}"><g class="fl ${kind}">${v.body.join('')}</g></svg>`;
  return `<div class="flow ${extraClass}">${svg(wide, 'fw')}${svg(tall, 'fn')}${kind === 'rail' ? railNow(spec) : ''}${spec.caption ? `<p class="flowcap">${esc(spec.caption)}</p>` : ''}</div>`;
}

// ---------- page ----------
const blocked = d.items.filter(i => i.state === 'blocked' || i.state === 'failed').length;
const needs = d.needs.length;
const stateCls = blocked ? 'blocked' : needs ? 'need' : 'ok';
const stateText = [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : null, blocked ? `${blocked} blocked` : null].filter(Boolean).join(' · ') || 'Nothing needs you';
const c = d.session.counts || {};
const counter = (cls, icon, count, label) => { const n = Number(count) || 0; return `<div class="ct ${cls}${n ? '' : ' zero'}"><span class="ic">${icon}</span><b>${n}</b><span class="lb">${label}</span></div>`; };

const href = u => SAFE_HREF.test(String(u || '')) ? esc(u) : '#';
const needCard = q => `<details class="need"><summary><span class="qid">${esc(q.id)}</span><span class="qq">${esc(q.q)}</span><span class="age">${esc(q.age)}</span>${q.link ? `<a class="btn sm" href="${href(q.link)}">Answer →</a>` : ''}</summary>
  <div class="nbody"><div class="ask-from">${esc(q.item)} · ${esc(q.role)} · blocks ${esc(q.blocks)}</div>
  <div class="choices">${(q.options || []).map(o => `<span class="choice${o.rec ? ' rec' : ''}"${o.rec ? ' title="Recommended"' : ''}>${o.rec ? '★ ' : ''}${esc(o.label)}</span>`).join('')}</div>
  ${q.why ? `<div class="why">${esc(q.why)}${q.files ? ` <a href="${href(q.files)}">Options page</a>` : ''}</div>` : ''}</div></details>`;
const sec = (title, n, body) => `<details class="sec" open><summary><h2>${title}${n != null ? ` <span class="n">${n}</span>` : ''}</h2></summary>${body}</details>`;

// Sources and links: rows grouped under a small heading per `group`, in first-seen order.
const refRow = r => `<div class="rr"><a href="${href(r.link)}">${esc(r.label)}</a>${r.note ? ` <span class="dt">${esc(r.note)}</span>` : ''}</div>`;
const refSec = (title, list) => {
  if (!list.length) return '';
  const groups = new Map();
  for (const r of list) { const name = r.group || 'Other'; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(r); }
  return sec(title, list.length, `<div class="refs">${[...groups].map(([name, rs]) => `<div class="rg"><div class="rgh">${esc(name)} <span class="rgn">${rs.length}</span></div>${rs.map(refRow).join('')}</div>`).join('')}</div>`);
};

const ITEM_STATES = new Set(['now', 'need', 'blocked', 'failed', 'done']);
const itemCard = it => `<div class="card item ${ITEM_STATES.has(it.state) ? it.state : 'now'}">
  <div class="hd"><a class="name" href="${href(it.link)}">${esc(it.name)}</a><span class="where">${it.pr ? `<a href="${href(it.prLink)}">${esc(it.pr)}</a> · ` : ''}${it.paneLink ? `<a href="${href(it.paneLink)}">open ↗</a>` : esc(it.pane)}</span></div>
  ${it.rail?.length ? diagram({ steps: it.rail }, 'rail', 'bare') : ''}
  <div class="tn">${rich(it.next)}</div></div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta http-equiv="refresh" content="60"><meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<title>${esc(d.session.title)}</title>
<style>
@font-face{font-family:"Inter Page";src:url(data:font/woff2;base64,${fs.readFileSync(path.join(here, 'inter-latin-wght-normal.woff2')).toString('base64')}) format("woff2");font-weight:100 900;font-display:block}
:root{--bg:#f8f4ef;--paper:#fffdfa;--ink:#2a2230;--muted:#75687a;--line:#e8dfd6;--link:#4a3f55;--wash:#f3ece4;--todo:#d3c8bf;
 --ok:#3f8a5a;--ok-wash:#e6f1e6;--run:#5b5fc7;--run-wash:#ecebfb;--warn:#c06a12;--warn-wash:#fcefdc;--bad:#c2414b;--bad-wash:#fbe5e6}
@media(prefers-color-scheme:dark){:root{--bg:#1b1720;--paper:#241f2b;--ink:#efe8f0;--muted:#a99fb0;--line:#3a3242;--link:#d9cfe0;--wash:#2e2736;--todo:#4d4456;
 --ok:#7fcf98;--ok-wash:#1f3326;--run:#9a9cff;--run-wash:#2a2850;--warn:#f2a65a;--warn-wash:#3c2a18;--bad:#f2808a;--bad-wash:#41222a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13.5px/1.55 "Inter Page",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"cv11","ss01"}
a{color:var(--link);text-underline-offset:3px;text-decoration-color:var(--line)}a:hover{text-decoration-color:currentColor}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--wash);padding:1px 5px;border-radius:4px}
.wrap{max-width:860px;margin:auto;padding:18px 18px 48px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px 20px;flex-wrap:wrap}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:6px}
.eyebrow:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--run)}
h1{font-size:clamp(19px,2.6vw,23px);font-weight:700;letter-spacing:-.025em;line-height:1.15;margin:4px 0 0}
h2{font-size:10.5px;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:22px 0 8px}
.counts{display:flex;gap:6px}
.ct{display:grid;grid-template-columns:auto auto;column-gap:7px;align-items:center;padding:4px 10px 4px 7px;border-radius:10px;background:var(--paper);border:1px solid var(--line)}
.ct .ic{grid-row:span 2;width:14px;height:14px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800}
.ct b{font-size:15px;line-height:1;font-weight:700}
.ct .lb{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.ct.run .ic{background:var(--run);box-shadow:0 0 0 3px var(--run-wash);animation:pulse 2s ease-in-out infinite}.ct.run b{color:var(--run)}
.ct.q .ic{border:2px dashed var(--todo)}
.ct.done .ic{background:var(--ok-wash);color:var(--ok)}.ct.done b{color:var(--ok)}
.ct.zero{opacity:.5}.ct.zero .ic{animation:none;box-shadow:none}
@keyframes pulse{50%{box-shadow:0 0 0 6px transparent}}
@media(prefers-reduced-motion:reduce){.ct .ic{animation:none!important}}
.state{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 0;padding:8px 14px;font-size:13.5px;border-radius:10px;border:1px solid;font-weight:650}
.state .sdot{width:8px;height:8px;border-radius:50%;background:currentColor}
.state .snext{color:var(--muted);font-weight:400;margin-left:auto;font-size:12.5px}
.state.ok{background:var(--ok-wash);color:var(--ok)}.state.need{background:var(--warn-wash);color:var(--warn)}.state.blocked{background:var(--bad-wash);color:var(--bad)}
.ask{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 24px;align-items:center;background:var(--paper);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:8px;padding:11px 14px;margin-bottom:8px}
.ask-from{font-size:11.5px;color:var(--muted)}.ask-from b{color:var(--warn)}
.ask-q{font-size:14.5px;font-weight:600;letter-spacing:-.01em;margin:2px 0 8px}
.choices{display:flex;gap:5px;flex-wrap:wrap;font-size:12px}
.choice{border:1px solid var(--line);border-radius:5px;padding:1px 8px;color:var(--muted)}
.choice.rec{border-color:var(--ok);color:var(--ok);background:var(--ok-wash);font-weight:600}
.why{font-size:12px;color:var(--muted);margin-top:6px}
.act{text-align:right}.age{display:block;font-size:11px;color:var(--warn);margin-top:6px}
.btn{display:inline-block;background:var(--ink);color:var(--bg);padding:6px 11px;border-radius:7px;font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap}
.card{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:8px}
.item{border-left:3px solid var(--line)}.item.now{border-left-color:var(--run)}.item.need{border-left-color:var(--warn)}.item.blocked,.item.failed{border-left-color:var(--bad)}.item.done{border-left-color:var(--ok)}
.hd{display:flex;justify-content:space-between;gap:6px 12px;flex-wrap:wrap;align-items:baseline}
.name{font-size:14.5px;font-weight:650;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.where{font-size:11.5px;color:var(--muted)}.where a{color:var(--muted)}
.tn{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.pill{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:1px 8px;border-radius:999px;margin-right:6px;vertical-align:1px}
.pill.now{background:var(--run-wash);color:var(--run)}.pill.need{background:var(--warn-wash);color:var(--warn)}.pill.blocked,.pill.failed{background:var(--bad-wash);color:var(--bad)}.pill.done{background:var(--ok-wash);color:var(--ok)}
.flow{container-type:inline-size;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.flow svg{width:100%;height:auto;display:block}.flow .fn{display:none;max-width:380px;margin:auto}
@container (max-width:600px){.flow .fw{display:none}.flow .fn{display:block}}
.flow.bare{background:none;border:0;padding:0;margin:8px 0 4px}.flow.bare .fn{max-width:none;margin:0}
.railnow{display:none;margin:2px 0 0;font-size:11.5px;color:var(--muted)}.railnow b.now{color:var(--run)}.railnow b.need{color:var(--warn)}.railnow b.blocked,.railnow b.failed{color:var(--bad)}.railnow b.done{color:var(--ok)}
@container (max-width:600px){.railnow{display:block}}
.flowcap{margin:4px 0 0;text-align:center;font-size:11.5px;color:var(--muted)}
.fl text{font:500 14px "Inter Page",system-ui,sans-serif;fill:var(--ink)}.fl text.mut{fill:var(--muted)}
.fl text.on{font-weight:700}.fl text.now{fill:var(--run)}.fl text.need{fill:var(--warn)}.fl text.blocked,.fl text.failed{fill:var(--bad)}
.fl .tag{font-size:10.5px;font-weight:700;letter-spacing:.1em}.fl .bang{font-size:11px;font-weight:800;fill:var(--paper)}
.fl.rail text{font-size:13px}
.done-list{display:grid;gap:0;background:var(--paper);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.done-list div{padding:6px 14px;border-top:1px solid var(--line);font-size:12.5px}.done-list div:first-child{border-top:0}
.done-list .ck{color:var(--ok);font-weight:800;margin-right:8px}.done-list .did{display:inline-block;min-width:34px;color:var(--muted);font-variant-numeric:tabular-nums}.done-list .dt{color:var(--muted)}
table{width:100%;border-collapse:collapse;background:var(--paper);border:1px solid var(--line);border-radius:8px;font-size:12.5px}
th,td{text-align:left;padding:6px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:11px}
details{margin-top:14px;font-size:12px;color:var(--muted)}summary{cursor:pointer}
.decs{background:var(--paper);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.dec{margin:0;border-top:1px solid var(--line);font-size:12.5px;color:var(--ink)}.dec:first-child{border-top:0}
.dec summary{list-style:none;cursor:pointer;padding:6px 14px;display:flex;gap:8px;align-items:baseline}
.dec summary::-webkit-details-marker{display:none}
.dec summary:after{content:"›";margin-left:auto;color:var(--muted);transition:transform .15s}.dec[open] summary:after{transform:rotate(90deg)}
.dec summary:hover{background:var(--wash)}
.did{display:inline-block;min-width:30px;white-space:nowrap;flex:none;color:var(--muted);font-variant-numeric:tabular-nums}
.dbody{padding:2px 14px 10px 52px}
.dq{font-weight:600;margin-bottom:6px}
.choice.picked{border-color:var(--ok);color:var(--ok);background:var(--ok-wash);font-weight:600}
.dmeta{font-size:11px;color:var(--muted);margin-top:6px}
.refs{display:grid;grid-template-columns:minmax(0,1fr);background:var(--paper);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.rg{border-top:1px solid var(--line)}.rg:first-child{border-top:0}
.rgh{padding:8px 14px 2px;overflow-wrap:anywhere;font-size:10.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.rgn{margin-left:2px;font-weight:500;opacity:.7}
.rr{display:flex;gap:8px;align-items:baseline;padding:3px 14px 3px 24px;font-size:12.5px;min-width:0}.rg .rr:last-child{padding-bottom:9px}
.rr a{overflow-wrap:anywhere}.rr .dt{color:var(--muted);flex:1;min-width:0;overflow-wrap:anywhere}
.needs{background:var(--paper);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:8px;overflow:hidden}
.need{border-top:1px solid var(--line)}.need:first-child{border-top:0}
.need summary{list-style:none;cursor:pointer;padding:7px 12px 7px 12px;display:flex;gap:10px;align-items:center}
.need summary::-webkit-details-marker,.sec>summary::-webkit-details-marker{display:none}.need summary:hover{background:var(--wash)}
.need summary:before{content:"›";color:var(--muted);transition:transform .15s;width:8px}.need[open] summary:before{transform:rotate(90deg)}
.qid{font-weight:700;color:var(--warn);font-size:12px;min-width:34px}.qid:empty{display:none}
.qq{flex:1;min-width:0;font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.need[open] .qq{white-space:normal}
.need .age{display:inline;margin:0;font-size:11px;color:var(--warn);white-space:nowrap}
.btn.sm{padding:3px 9px;font-size:11.5px;border-radius:6px}
.nbody{padding:0 14px 10px 64px}.nbody .ask-from{margin-bottom:6px}
.sec{margin:0}.sec>summary{list-style:none;cursor:pointer;display:block;border-radius:6px}
.sec>summary h2{display:flex;align-items:center;gap:6px;margin:20px 0 8px}
.sec>summary h2:before{content:"›";font-size:13px;transition:transform .15s;transform:rotate(90deg);display:inline-block;width:8px}
.sec:not([open])>summary h2:before{transform:none}
.sec>summary:hover h2{color:var(--ink)}
.sec .n{font-weight:600;background:var(--wash);color:var(--muted);border-radius:999px;padding:0 6px;font-size:10px;letter-spacing:0}
@media(max-width:640px){.qq{white-space:normal}.nbody,.dbody{padding-left:14px}.need[open] summary{flex-wrap:wrap}.need[open] .qq{order:1;flex-basis:100%;overflow:visible}.ask{grid-template-columns:1fr}.act{text-align:left}.state .snext{margin-left:0;flex-basis:100%}}
</style></head><body><div class="wrap">
<div class="top"><div><div class="eyebrow">${esc(d.session.eyebrow)}</div><h1>${esc(d.session.title)}</h1></div>
<div class="counts">${counter('run', '', c.running, 'running')}${counter('q', '', c.queued, 'queued')}${counter('done', '✓', c.done, 'done')}</div></div>
<div class="state ${stateCls}"><span class="sdot"></span>${esc(stateText)}</div>
${needs ? sec('Needs you', needs, `<div class="needs">${d.needs.map(needCard).join('')}</div>`) : ''}
${sec('In flight', d.items.length, d.items.length ? d.items.map(itemCard).join('') : '<p class="tn">Nothing in flight.</p>')}
${d.session.flow?.steps?.length && d.items.length > 1 ? sec('Order of work', null, diagram(d.session.flow, 'boxes')) : ''}
${d.done.length ? sec('Done', d.done.length, `<div class="done-list">${d.done.map(x => `<div><span class="ck">✓</span><a href="${href(x.link)}">${esc(x.label)}</a> <span class="dt">${esc(x.detail || '')}</span></div>`).join('')}</div>`) : ''}
${d.decisions.length ? sec('Decisions', d.decisions.length, `<div class="decs">${d.decisions.map(x => `<details class="dec"><summary><span class="did">${esc(x.id)}</span><span class="dans">${esc(x.answer)}</span></summary><div class="dbody">
  ${x.q ? `<div class="dq">${esc(x.q)}</div>` : ''}
  ${x.options ? `<div class="choices">${x.options.map(o => `<span class="choice${o === x.chosen ? ' picked' : ''}">${o === x.chosen ? '✓ ' : ''}${esc(o)}</span>`).join('')}</div>` : ''}
  ${x.note ? `<div class="why">${esc(x.note)}</div>` : ''}
  <div class="dmeta">${esc([x.by && `Answered by ${x.by}`, x.when, x.ref].filter(Boolean).join(' · '))}</div></div></details>`).join('')}</div>`) : ''}
${refSec('Sources', d.sources)}
${refSec('Relevant links', d.links)}
${sec('Settings', null, `<p class="tn">${rich(d.session.settings)}</p>`).replace(' open>', '>')}
</div></body></html>
`;
fs.writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${Math.round(html.length / 1024)} KB)`);
