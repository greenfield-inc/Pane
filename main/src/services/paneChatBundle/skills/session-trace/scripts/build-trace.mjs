#!/usr/bin/env node
// Build a trace page (trace.html) and OpenTelemetry spans (trace.otlp.json) from a
// Claude Code or Codex session log. No dependencies; Node 18+.
//
//   node build-trace.mjs --out DIR [--session FILE] [--title TEXT] [--back HREF] [--story FILE] [--outline]
//
// --outline prints one line per request (anchor, time, steps, first line) to pick key moments from.
// --story FILE is JSON {"summary": "...", "moments": [{"turn": 12, "title": "...", "detail": "..."}]};
// the summary and key moments are placed above the timeline and starred on it.
//
// Without --session it finds the current session: $CLAUDE_CODE_SESSION_ID for Claude,
// otherwise the newest top-level Codex rollout whose working directory is this one.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {parseArgs} from 'node:util';

const {values: opt} = parseArgs({options: {out: {type: 'string'}, session: {type: 'string'}, title: {type: 'string'}, back: {type: 'string'}, story: {type: 'string'}, outline: {type: 'boolean'}}});
if (!opt.out) { console.error('usage: build-trace.mjs --out DIR [--session FILE] [--title TEXT] [--back HREF] [--story FILE] [--outline]'); process.exit(2); }

const SECRET = /gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[bpa]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g;
const clean = s => String(s ?? '').replace(SECRET, '[redacted]');
const PR = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const readJsonl = file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(b => b && typeof b.text === 'string').map(b => b.text).join('\n');
const firstLine = s => clean(String(s ?? '').split('\n').find(l => l.trim()) ?? '').trim();

function findSession() {
  if (opt.session) return path.resolve(opt.session);
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (id) {
    const root = path.join(os.homedir(), '.claude/projects');
    for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const file = path.join(root, dir, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  const cwd = fs.realpathSync(process.cwd()), candidates = [];
  const walk = dir => { for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes: true}) : []) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) candidates.push(p); } };
  walk(path.join(os.homedir(), '.codex/sessions'));
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of candidates.slice(0, 200)) {
    const meta = codexMeta(file);
    if (meta && !meta.parent_thread_id && meta.cwd && fs.existsSync(meta.cwd) && fs.realpathSync(meta.cwd) === cwd) return file;
  }
  throw Error('No session log found; pass --session FILE');
}

function codexMeta(file) {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
  try { const d = JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]); return d.type === 'session_meta' ? d.payload : null; } catch { return null; }
}

// ---- Claude Code ----------------------------------------------------------
const CLAUDE_NOISE = ['<local-command', '<command-name>', '<command-message>', '<task-notification>', 'This session is being continued', '[Request interrupted', '<system-reminder>', 'Caveat:'];
function claudeSteps(rows) {
  const uses = new Map(), results = new Map();
  for (const d of rows) for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
    if (b?.type === 'tool_use') uses.set(b.id, {ts: d.timestamp, b});
    if (b?.type === 'tool_result') results.set(b.tool_use_id, {ts: d.timestamp, error: !!b.is_error, text: textOf(b.content)});
  }
  return [...uses].map(([id, {ts, b}]) => {
    const i = b.input ?? {}, r = results.get(id);
    return {id, start: ts, end: r?.ts ?? ts, error: r?.error ?? false, output: r?.text ?? '',
      tool: b.name.replace(/^mcp__(plugin_)?(\w+?)_?\w*?__/, '$2.'),
      label: clean(i.description ?? i.file_path ?? i.query ?? i.skill ?? i.url ?? '').slice(0, 160),
      detail: firstLine(i.command ?? i.prompt ?? i.pattern ?? '').slice(0, 220)};
  }).sort((a, b) => a.start.localeCompare(b.start));
}
function parseClaude(file) {
  const rows = readJsonl(file), turns = [];
  let cur = null;
  for (const d of rows) {
    if (!d.timestamp) continue;
    const m = d.message ?? {}, c = m.content;
    const isHuman = d.type === 'user' && m.role === 'user' && !d.isMeta && !d.isCompactSummary && !(Array.isArray(c) && c.some(b => b?.type === 'tool_result'));
    const text = isHuman ? textOf(c).trim() : '';
    if (text && !CLAUDE_NOISE.some(n => text.startsWith(n))) { cur = {start: d.timestamp, end: d.timestamp, ask: clean(text), replies: [], rows: []}; turns.push(cur); continue; }
    if (!cur) continue;
    cur.rows.push(d); if (d.timestamp > cur.end) cur.end = d.timestamp;
    if (d.type === 'assistant' && Array.isArray(c)) { const t = textOf(c).trim(); if (t) cur.replies.push(clean(t)); }
  }
  for (const t of turns) { t.steps = claudeSteps(t.rows); delete t.rows; }
  const subagents = [], dir = file.replace(/\.jsonl$/, '/subagents');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) : []) {
    const rows = readJsonl(path.join(dir, f)), stamps = rows.map(r => r.timestamp).filter(Boolean).sort();
    const metaFile = path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    if (stamps.length) subagents.push({id: f.replace(/\.jsonl$/, ''), description: clean(meta.description ?? 'subagent'), start: stamps[0], end: stamps.at(-1), steps: claudeSteps(rows)});
  }
  const prs = new Map();
  for (const d of rows) if (d.type === 'pr-link' && d.prUrl) prs.set(d.prUrl, {url: d.prUrl, repo: d.prRepository, number: d.prNumber, time: d.timestamp});
  const model = rows.find(d => d.type === 'assistant' && d.message?.model)?.message.model;
  return {harness: 'claude', id: path.basename(file, '.jsonl'), model, turns, subagents, prs};
}

// ---- Codex ----------------------------------------------------------------
function codexLabel(p) {
  let args = p.arguments ?? p.input ?? '';
  try { const j = JSON.parse(args); args = j.cmd ?? j.command ?? j; } catch {}
  if (Array.isArray(args)) args = args.join(' ');
  if (typeof args === 'object') args = JSON.stringify(args);
  const cmd = /"(?:cmd|command)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args)?.[1]?.replace(/\\"/g, '"').replace(/\\n/g, '\n');
  return firstLine(cmd ?? args).slice(0, 220);
}
function codexThread(rows) {
  const calls = new Map(), outputs = new Map(), turns = [];
  let cur = null;
  const open = (ts, ask) => { cur = {start: ts, end: ts, ask: clean(ask), replies: [], ids: []}; turns.push(cur); };
  for (const d of rows) {
    const p = d.payload ?? {}, ts = d.timestamp;
    if (!ts) continue;
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const t = textOf(p.content).trim();
      if (t && !/^<[a-z_]+[\s>]/i.test(t) && !t.startsWith('# AGENTS.md')) { open(ts, t); continue; }
    }
    if (d.type === 'response_item' && p.type === 'agent_message' && !cur) { open(ts, textOf(p.content)); continue; }
    if (!cur) continue;
    if (ts > cur.end) cur.end = ts;
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'assistant') { const t = textOf(p.content).trim(); if (t) cur.replies.push(clean(t)); }
    if (d.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) { calls.set(p.call_id, {ts, p}); cur.ids.push(p.call_id); }
    if (d.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) outputs.set(p.call_id, {ts, text: typeof p.output === 'string' ? p.output : textOf(p.output)});
  }
  for (const t of turns) {
    t.steps = t.ids.map(id => { const {ts, p} = calls.get(id), o = outputs.get(id); const detail = codexLabel(p);
      return {id, start: ts, end: o?.ts ?? ts, error: /exit code: [1-9]|Process exited with code [1-9]/.test(o?.text ?? ''), output: o?.text ?? '', tool: p.name, label: detail.slice(0, 160), detail}; });
    delete t.ids;
  }
  return turns;
}
function parseCodex(file) {
  const rows = readJsonl(file), meta = rows.find(d => d.type === 'session_meta')?.payload ?? {}, turns = codexThread(rows);
  const stamps = rows.map(r => r.timestamp).filter(Boolean).sort(), subagents = [];
  const days = new Set(); for (let t = new Date(stamps[0]); t <= new Date(stamps.at(-1)); t = new Date(t.getTime() + 864e5)) days.add(t.toISOString().slice(0, 10));
  days.add(stamps.at(-1).slice(0, 10));
  for (const day of days) {
    const dir = path.join(os.homedir(), '.codex/sessions', ...day.split('-'));
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const child = path.join(dir, f), m = codexMeta(child);
      if (!m || m.parent_thread_id !== meta.id) continue;
      const crows = readJsonl(child), ct = codexThread(crows), cst = crows.map(r => r.timestamp).filter(Boolean).sort();
      subagents.push({id: m.id, description: clean(firstLine(ct[0]?.ask ?? m.agent_nickname ?? 'subagent')).slice(0, 140), start: cst[0], end: cst.at(-1), steps: ct.flatMap(t => t.steps)});
    }
  }
  const model = rows.find(d => d.type === 'turn_context')?.payload?.model;
  return {harness: 'codex', id: meta.id ?? path.basename(file), model, turns, subagents, prs: new Map()};
}

// ---- Shared ---------------------------------------------------------------
const file = findSession(), first = readJsonl(file).slice(0, 3);
const trace = first.some(d => d.type === 'session_meta') ? parseCodex(file) : parseClaude(file);
for (const s of [...trace.turns.flatMap(t => t.steps), ...trace.subagents.flatMap(a => a.steps)]) {
  if (!/\bgh pr create\b/.test(s.detail + ' ' + s.label)) continue;
  for (const m of s.output.matchAll(PR)) if (!trace.prs.has(m[0])) trace.prs.set(m[0], {url: m[0], repo: m[1], number: Number(m[2]), time: s.end});
}
const turns = trace.turns.filter(t => t.ask), subagents = trace.subagents, prs = [...trace.prs.values()].sort((a, b) => a.time.localeCompare(b.time));
if (!turns.length) throw Error(`No user requests found in ${file}`);

const E = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const ms = s => new Date(s).getTime();
const t0 = ms(turns[0].start), t1 = Math.max(...turns.map(t => ms(t.end)), ...subagents.map(a => ms(a.end))), SPAN = Math.max(t1 - t0, 1);
const pct = s => (100 * (ms(s) - t0) / SPAN).toFixed(2);
const clock = s => new Date(s).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
const day = s => new Date(s).toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
const dur = (a, b) => { const s = Math.max(0, (ms(b) - ms(a)) / 1000); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`; };
const zone = new Date(turns[0].start).toLocaleTimeString('en-US', {timeZoneName: 'short'}).split(' ').at(-1);
const trunc = (t, n) => t.length > n ? `${E(t.slice(0, n))}\n\n… (${(t.length - n).toLocaleString()} more characters)` : E(t);
const nsteps = turns.reduce((n, t) => n + t.steps.length, 0);
if (opt.outline) { for (const [i, t] of turns.entries()) console.log(`t${i}\t${clock(t.start)}\t${t.steps.length} steps\t${firstLine(t.ask).slice(0, 120)}`); process.exit(0); }
const story = opt.story ? JSON.parse(fs.readFileSync(opt.story, 'utf8')) : {};
const moments = (story.moments ?? []).filter(m => turns[m.turn]), starred = new Set(moments.map(m => m.turn));

function stepsHtml(steps, a, b) {
  const span = Math.max(ms(b) - ms(a), 1);
  return `<div class="steps">${steps.map(s => {
    const l = 100 * (ms(s.start) - ms(a)) / span, w = 100 * Math.max(0, ms(s.end) - ms(s.start)) / span;
    const extra = s.detail && s.detail !== s.label ? ` <small>${E(s.detail)}</small>` : '';
    return `<div class="st"><span class="meta">${clock(s.start)}</span><span class="tool">${E(s.tool)}${s.error ? ' ✖' : ''}</span><span class="lab" title="${E(s.detail)}">${E(s.label || s.tool)}${extra}</span><span class="mini"><i style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"></i></span></div>`;
  }).join('')}</div>`;
}
const lane = (start, end, href, text, cls = '', star = false) => `<div class="lane"><span class="meta">${star ? '★ ' : ''}${clock(start)}</span><a class="track" href="#${href}"><span class="bar ${cls}" style="left:${pct(start)}%;width:${Math.max(pct(end) - pct(start), 0.15)}%"></span></a><a class="txt" href="#${href}">${E(text)}</a></div>`;
const hours = []; for (let h = new Date(t0); h.setMinutes(60, 0, 0) < t1;) hours.push(`<span class="hr" style="left:${(100 * (h - t0) / SPAN).toFixed(2)}%">${h.toLocaleTimeString('en-US', {hour: 'numeric'})}</span>`);
const turnHtml = turns.map((t, i) => {
  const head = firstLine(t.ask).slice(0, 110), reply = t.replies.at(-1) ?? '', earlier = t.replies.slice(0, -1);
  return `<details class="turn" id="t${i}" data-text="${E((t.ask + ' ' + t.steps.map(s => s.label + ' ' + s.detail).join(' ')).toLowerCase().slice(0, 20000))}"><summary><span class="meta">${clock(t.start)}</span><span class="ask">${E(head)}</span><span class="meta">${t.steps.length} steps · ${dur(t.start, t.end)}</span></summary>
<div class="q">${trunc(t.ask, 2500)}</div>
${earlier.length ? `<details><summary class="meta">${earlier.length} earlier progress updates</summary>${earlier.map(r => `<div class="reply">${E(r.slice(0, 3000))}</div>`).join('')}</details>` : ''}
${t.steps.length ? stepsHtml(t.steps, t.start, t.end) : ''}
${reply ? `<div class="reply">${E(reply)}</div>` : ''}<a class="up" href="#timeline">↑ Timeline</a></details>`;
}).join('\n');
const title = opt.title ?? `Session trace, ${day(turns[0].start)}`;
const page = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${E(title)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5d5b55;--card:#fff;--line:#e4e1d8;--accent:#2f6f4f;--code:#f1efe8;--sub:#7a4fb5;--pr:#2c62a8;--err:#b5473a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--fg:#ecebe6;--muted:#a3a19a;--card:#1e1e1c;--line:#33322e;--accent:#7cc39c;--code:#262522;--sub:#b596e0;--pr:#7fa8e0;--err:#e08a7c;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#151514;--fg:#ecebe6;--muted:#a3a19a;--card:#1e1e1c;--line:#33322e;--accent:#7cc39c;--code:#262522;--sub:#b596e0;--pr:#7fa8e0;--err:#e08a7c;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px 16px 56px}
main{max-width:1040px;margin:0 auto}a{color:var(--pr)}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:26px 0 10px;color:var(--accent)}h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:18px 0 8px}
.lede,.muted,.meta{color:var(--muted)}.meta{font-size:12.5px;white-space:nowrap}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 20px 14px;margin-bottom:14px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.stats div{border:1px solid var(--line);border-radius:8px;padding:8px 12px;background:var(--card)}.stats b{display:block;font-size:20px}
.legend{font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:middle}
.lane{display:grid;grid-template-columns:64px minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:center;font-size:12.5px;margin:2px 0}
.lane .txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);text-decoration:none}.lane .txt:hover{color:var(--fg)}
.track{display:block;position:relative;height:14px;background:var(--code);border-radius:4px}
.bar{position:absolute;top:0;height:14px;border-radius:4px;background:var(--accent);min-width:3px;opacity:.85}.bar.sub{background:var(--sub)}
.axis{position:relative;height:16px}.hr{position:absolute;font-size:11px;color:var(--muted);transform:translateX(-50%)}
.pr{position:absolute;top:-3px;width:2px;height:20px;background:var(--pr)}
.turn{border-top:1px solid var(--line);padding:10px 0}
.turn>summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:78px 1fr auto;gap:10px;align-items:baseline}.turn>summary::-webkit-details-marker{display:none}
.ask{font-weight:600}
.q{white-space:pre-wrap;background:var(--code);border-radius:8px;padding:10px 12px;font-size:13.5px;margin:8px 0;max-height:320px;overflow:auto}
.reply{white-space:pre-wrap;border-left:3px solid var(--accent);padding:4px 12px;font-size:13.5px;margin:8px 0;max-height:420px;overflow:auto}
.st{display:grid;grid-template-columns:64px 130px minmax(0,1fr) 170px;gap:8px;align-items:center;font-size:12.5px;padding:2px 0}
.st .lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.st small{color:var(--muted);font-family:ui-monospace,monospace}
.tool{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
.mini{position:relative;height:10px;background:var(--code);border-radius:3px}.mini i{position:absolute;top:0;height:10px;background:var(--accent);border-radius:3px;min-width:2px}
.moments{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin:8px 0}
.moment{display:flex;flex-direction:column;gap:4px;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:10px 12px;color:var(--fg);text-decoration:none;background:var(--bg)}.moment:hover{border-color:var(--accent)}.moment span:last-child{font-size:13.5px;color:var(--muted)}
.tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0 4px}
.tools input{flex:1 1 220px;font:inherit;font-size:14px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.tools button{font:inherit;font-size:13.5px;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);cursor:pointer}
.turn:target,.moment:target{outline:2px solid var(--accent);outline-offset:4px;border-radius:6px}
:focus-visible{outline:2px solid var(--pr);outline-offset:2px}
.up{display:inline-block;font-size:12.5px;margin-top:4px}
.q,.reply{overflow-wrap:anywhere}
.prs{columns:2 300px;font-size:13.5px;padding-left:18px}
@media (max-width:640px){body{padding:20px 12px 40px}section{padding:4px 14px 12px}.lane{grid-template-columns:56px 1fr;min-height:26px}.track,.bar{height:18px}.lane .txt{display:none}.st{grid-template-columns:56px 1fr;padding:4px 0}.st .lab{white-space:normal;overflow-wrap:anywhere}.st small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.st .tool,.st .mini{display:none}.turn>summary{grid-template-columns:64px 1fr}.turn>summary .meta:last-child{display:none}}
</style>
<main>
${opt.back ? `<p class="muted"><a href="${E(opt.back)}">← Back</a></p>` : ''}
<h1>${E(title)}</h1>
<p class="lede">Every request, every step the agent took, its subagents, and the PRs it opened, from the ${trace.harness === 'claude' ? 'Claude Code' : 'Codex'} session log${trace.model ? ` (${E(trace.model)})` : ''}. ${day(turns[0].start)}, ${clock(turns[0].start)} – ${clock(new Date(t1).toISOString())} ${zone}. Command output is left out; emails and tokens are redacted.</p>
<div class="stats"><div><b>${turns.length}</b>requests</div><div><b>${nsteps}</b>tool calls</div><div><b>${subagents.length}</b>subagents</div><div><b>${prs.length}</b>PRs</div><div><b>${dur(turns[0].start, new Date(t1).toISOString())}</b>wall clock</div></div>
${story.summary ? `<section><h2>What happened</h2>${String(story.summary).split(/\n\s*\n/).map(p => `<p>${E(p)}</p>`).join('')}</section>` : ''}
${moments.length ? `<section><h2>Key moments</h2><div class="moments">${moments.map(m => `<a class="moment" href="#t${m.turn}"><span class="meta">★ ${clock(turns[m.turn].start)}</span><b>${E(m.title)}</b>${m.detail ? `<span>${E(m.detail)}</span>` : ''}</a>`).join('')}</div></section>` : ''}
<section id="timeline"><h2>Timeline</h2>
<p class="legend">Each row is one request on the session's clock. Click one to see its steps.<i style="background:var(--accent)"></i>request<i style="background:var(--sub)"></i>subagent<i style="background:var(--pr)"></i>PR opened</p>
<div class="lane"><span></span><div class="axis">${hours.join('')}</div><span></span></div>
${prs.length ? `<div class="lane"><span class="meta">PRs</span><div class="track" style="background:none">${prs.map(p => `<span class="pr" style="left:${pct(p.time)}%" title="${E(p.repo)}#${p.number}"></span>`).join('')}</div><span class="meta">${prs.length} PRs</span></div>` : ''}
${turns.map((t, i) => lane(t.start, t.end, `t${i}`, firstLine(t.ask).slice(0, 140), '', starred.has(i))).join('\n')}
${subagents.length ? `<h3>Subagents</h3>${subagents.map((a, i) => lane(a.start, a.end, `a${i}`, a.description, 'sub')).join('\n')}` : ''}
</section>
${prs.length ? `<section><h2>Pull requests</h2><ol class="prs">${prs.map(p => `<li><a href="${E(p.url)}">${E(p.repo)} #${p.number}</a> <span class="meta">${clock(p.time)}</span></li>`).join('')}</ol></section>` : ''}
<section id="requests"><h2>Every request, step by step</h2><p class="muted">Open a request to see what was asked, each tool call with its timing, and the reply.</p>
<div class="tools"><input id="filter" type="search" placeholder="Filter requests and steps…" aria-label="Filter requests and steps"><button type="button" id="expand">Expand all</button><span class="meta" id="count"></span></div>
${turnHtml}</section>
${subagents.length ? `<section><h2>Subagents</h2>${subagents.map((a, i) => `<details class="turn" id="a${i}"><summary><span class="meta">${clock(a.start)}</span><span class="ask">${E(a.description)}</span><span class="meta">${a.steps.length} steps · ${dur(a.start, a.end)}</span></summary>${stepsHtml(a.steps, a.start, a.end)}</details>`).join('\n')}</section>` : ''}
<section><h2>Raw trace</h2><p>The same trace as OpenTelemetry spans (OTLP JSON), for any OTel viewer: <a href="trace.otlp.json">trace.otlp.json</a>.</p></section>
</main>
<script>
const turns=[...document.querySelectorAll('#requests .turn')],filter=document.getElementById('filter'),expand=document.getElementById('expand'),count=document.getElementById('count');
const smooth=matchMedia('(prefers-reduced-motion: no-preference)').matches?'smooth':'auto';
function jump(){const el=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(el&&el.tagName==='DETAILS'){el.open=true;el.hidden=false;el.scrollIntoView({block:'start',behavior:smooth});}}
addEventListener('hashchange',jump);jump();
filter.addEventListener('input',()=>{const q=filter.value.trim().toLowerCase();let n=0;for(const t of turns){const hit=!q||t.dataset.text.includes(q);t.hidden=!hit;if(hit)n++;}count.textContent=q?n+' of '+turns.length:'';});
expand.addEventListener('click',()=>{const openAll=!turns.every(t=>t.open||t.hidden);for(const t of turns)if(!t.hidden)t.open=openAll;expand.textContent=openAll?'Collapse all':'Expand all';});
</script>
`;

const hex = (n, ...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, n);
const ns = s => String(BigInt(ms(s)) * 1000000n);
const attr = (key, v) => ({key, value: {stringValue: String(v)}});
const traceId = hex(32, trace.id), root = hex(16, 'root'), end = new Date(t1).toISOString();
const spans = [{traceId, spanId: root, name: `${trace.harness} session`, startTimeUnixNano: ns(turns[0].start), endTimeUnixNano: ns(end), attributes: [attr('session.id', trace.id), ...(trace.model ? [attr('gen_ai.request.model', trace.model)] : [])]}];
const stepSpans = (steps, parent) => steps.map(s => ({traceId, spanId: hex(16, parent, s.id), parentSpanId: parent, name: `tool.${s.tool}`, startTimeUnixNano: ns(s.start), endTimeUnixNano: ns(s.end), status: {code: s.error ? 2 : 1}, attributes: [attr('tool.description', s.label || s.detail)]}));
turns.forEach((t, i) => { const id = hex(16, 'turn', String(i)); spans.push({traceId, spanId: id, parentSpanId: root, name: 'user_request', startTimeUnixNano: ns(t.start), endTimeUnixNano: ns(t.end), attributes: [attr('user.prompt', t.ask.slice(0, 4000))]}, ...stepSpans(t.steps, id)); });
subagents.forEach(a => { const id = hex(16, 'agent', a.id); spans.push({traceId, spanId: id, parentSpanId: root, name: 'subagent', startTimeUnixNano: ns(a.start), endTimeUnixNano: ns(a.end), attributes: [attr('subagent.description', a.description)]}, ...stepSpans(a.steps, id)); });
prs.forEach(p => spans.push({traceId, spanId: hex(16, 'pr', p.url), parentSpanId: root, name: 'pull_request.opened', startTimeUnixNano: ns(p.time), endTimeUnixNano: ns(p.time), attributes: [attr('pr.url', p.url)]}));

fs.mkdirSync(opt.out, {recursive: true});
fs.writeFileSync(path.join(opt.out, 'trace.html'), page);
fs.writeFileSync(path.join(opt.out, 'trace.otlp.json'), JSON.stringify({resourceSpans: [{resource: {attributes: [attr('service.name', trace.harness === 'claude' ? 'claude-code' : 'codex')]}, scopeSpans: [{scope: {name: 'session-trace'}, spans}]}]}));
console.log(JSON.stringify({session: file, harness: trace.harness, requests: turns.length, tool_calls: nsteps, subagents: subagents.length, prs: prs.length, out: path.resolve(opt.out)}));
