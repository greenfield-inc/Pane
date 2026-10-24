#!/usr/bin/env node
/**
 * Theme contrast + color-vision-deficiency (CVD) gate for Pane themes.
 *
 * Reads frontend/src/styles/tokens/colors.css, resolves each theme's semantic
 * tokens (following the same class composition ThemeProvider applies), and
 * measures WCAG 2.x contrast for the text/UI/terminal pairs listed below.
 *
 *   node scripts/check-theme-contrast.mjs                 # gate every theme in GATED_THEMES
 *   node scripts/check-theme-contrast.mjs --themes dusk    # report any theme(s)
 *   node scripts/check-theme-contrast.mjs --all            # report every theme (report only, exit 0)
 *   node scripts/check-theme-contrast.mjs --markdown       # PR-ready tables
 *   node scripts/check-theme-contrast.mjs --cvd            # add CVD simulation tables
 *   node scripts/check-theme-contrast.mjs --verbose        # print passing rows too
 *
 * Exit code is 1 when a gated theme fails a threshold. Themes not listed in
 * GATED_THEMES (the twelve original themes) are report-only so existing debt
 * does not block CI. Each gated theme carries its own profile — see
 * GATED_THEMES: `strictUi` additionally gates the hairline pairs (1px input
 * border, scrollbar thumb, the subtle focus ring) and the "on-dark" link text
 * on the page background, which only the accessibility family commits to.
 *
 * CVD simulation uses the Machado, Oliveira & Fernandes (2009) severity-1.0
 * matrices applied in linear sRGB — the same matrices as the SVG filters used
 * for the simulated screenshots in tests/theme-screenshots.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { THEME_CLASSES } from '../shared/types/appearance.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const COLORS_CSS = path.join(here, '..', 'frontend', 'src', 'styles', 'tokens', 'colors.css');

// Themes that must pass, each with the bar its family was designed to.
//   body      minimum for text pairs (4.5 = AA; high-legibility promises AAA)
//   ui        minimum for painted UI (focus ring, input focus, accent, cursor)
//   terminal  minimum for the 16 ANSI colours on the terminal background
//   status    minimum for status colours on the page background (defaults to body)
//   strictUi  also gate hairline pairs (1px input border, scrollbar thumb, subtle
//             focus ring) and "on-dark" link text on the page background — the
//             accessibility family's promise; every other Pane theme keeps these
//             as report-only rows
//   cvd       also gate the colour-vision-deficiency simulation (Okabe-Ito theme)
const STANDARD = { body: 4.5, ui: 3, terminal: 4.5 };
const GATED_THEMES = {
  // neon (#451)
  'synthwave': STANDARD,
  'acid': STANDARD,
  'tokyo-rain': STANDARD,
  // editorial (#453)
  'folio': STANDARD,
  'newsprint': STANDARD,
  'walnut': STANDARD,
  // retro (#454)
  'amber-crt': STANDARD,
  'teletype': STANDARD,
  'dot-matrix': STANDARD,
  // atmosphere (#456) — designed to the 3:1 UI bar for ANSI and status colours
  'haar': { body: 4.5, ui: 3, terminal: 3, status: 3 },
  'abyss': STANDARD,
  'understory': STANDARD,
  // accessibility
  'colorblind-safe': { body: 4.5, ui: 3, terminal: 4.5, strictUi: true, cvd: true },
  'low-fatigue': { body: 4.5, ui: 3, terminal: 4.5, strictUi: true },
  'high-legibility': { body: 7, ui: 3, terminal: 4.5, strictUi: true },
};

// ---------- CSS parsing ----------

function parseBlocks(rawCss) {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = new Map(); // selector -> Map(var, value) (later blocks with the same selector are merged)
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    const selector = match[1].trim();
    const body = match[2];
    const vars = blocks.get(selector) ?? new Map();
    for (const decl of body.split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      const name = decl.slice(0, idx).trim();
      if (!name.startsWith('--')) continue;
      const value = decl.slice(idx + 1).trim();
      vars.set(name, value);
    }
    blocks.set(selector, vars);
  }
  return blocks;
}

function tokensFor(blocks, theme, highContrast = false) {
  const classes = THEME_CLASSES[theme];
  if (!classes) throw new Error(`Unknown theme "${theme}"`);
  const merged = new Map(blocks.get(':root') ?? []);
  const apply = (selector) => {
    for (const [name, value] of blocks.get(selector) ?? []) merged.set(name, value);
  };
  for (const cls of classes) apply(`:root.${cls}`);
  if (highContrast) for (const cls of classes) apply(`:root.high-contrast.${cls}`);
  return merged;
}

// ---------- color math ----------

function parseColor(raw) {
  const value = raw.trim();
  let m = value.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split('').map((c) => parseInt(c + c, 16));
      return { r, g, b, a: hex.length === 4 ? a / 255 : 1 };
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  m = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

function resolve(tokens, name, seen = new Set()) {
  const raw = tokens.get(name);
  if (raw === undefined) return undefined;
  if (seen.has(name)) return undefined;
  seen.add(name);
  // rgba(var(--x-rgb), 0.5) → expand the triplet
  const value = raw.replace(/var\((--[\w-]+)\)/g, (_, ref) => {
    const inner = resolve(tokens, ref, new Set(seen));
    return inner === undefined ? _ : inner;
  });
  return value;
}

function color(tokens, name) {
  const value = resolve(tokens, name);
  return value === undefined ? null : parseColor(value);
}

function composite(fg, bg) {
  if (!fg) return null;
  if (fg.a >= 1 || !bg) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const delin = (l) => {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

function luminance({ r, g, b }) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function hex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Machado, Oliveira & Fernandes 2009 — severity 1.0, applied in linear RGB.
const CVD_MATRICES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

function simulate(c, kind) {
  const m = CVD_MATRICES[kind];
  const v = [lin(c.r), lin(c.g), lin(c.b)];
  const out = m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return { r: delin(out[0]), g: delin(out[1]), b: delin(out[2]), a: 1 };
}

// CIE76 ΔE in Lab (D65) — coarse but adequate for "are these two colors confusable".
function toLab(c) {
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 1.0;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE(a, b) {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// ---------- checks ----------

const TEXT_ON_SURFACES = [
  ['--color-text-primary', '--color-bg-primary'],
  ['--color-text-primary', '--color-bg-secondary'],
  ['--color-text-primary', '--color-surface-primary'],
  ['--color-text-primary', '--color-surface-secondary'],
  ['--color-text-primary', '--color-bg-chrome'],
  ['--color-text-primary', '--color-bg-editor'],
  ['--color-text-secondary', '--color-bg-primary'],
  ['--color-text-secondary', '--color-surface-primary'],
  ['--color-text-secondary', '--color-surface-secondary'],
  ['--color-text-tertiary', '--color-bg-primary'],
  ['--color-text-tertiary', '--color-surface-secondary'],
  ['--color-text-muted', '--color-bg-primary'],
  ['--color-text-muted', '--color-surface-primary'],
  ['--color-text-interactive-muted', '--color-bg-primary'],
  ['--color-text-navigation-primary', '--color-surface-navigation'],
  ['--color-text-navigation-secondary', '--color-surface-navigation'],
  ['--color-text-navigation-muted', '--color-surface-navigation'],
  ['--color-text-navigation-section', '--color-surface-navigation'],
  ['--color-text-navigation-selected', '--color-surface-navigation-selected'],
  ['--color-text-navigation-hover', '--color-surface-navigation-hover'],
  ['--color-text-on-surface', '--color-surface-secondary'],
  ['--color-text-on-tertiary', '--color-bg-tertiary'],
  ['--color-interactive-text', '--color-bg-primary'],
  ['--color-interactive-text', '--color-surface-primary'],
  ['--color-text-interactive-on-dark', '--color-bg-primary', 'strict'],
  ['--color-button-primary-text', '--color-button-primary-bg'],
  ['--color-button-primary-text', '--color-button-primary-hover'],
  ['--color-button-secondary-text', '--color-button-secondary-bg'],
  ['--color-button-secondary-text', '--color-button-secondary-hover'],
  ['--color-button-ghost-text', '--color-bg-primary'],
  ['--color-button-ghost-text', '--color-button-ghost-hover'],
  ['--color-input-text', '--color-input-bg'],
  ['--color-input-placeholder', '--color-input-bg'],
  ['--color-text-on-status-success', '--color-status-success'],
  ['--color-text-on-status-warning', '--color-status-warning'],
  ['--color-text-on-status-error', '--color-status-error'],
  ['--color-text-on-status-info', '--color-status-info'],
  ['--color-text-on-interactive', '--color-interactive-primary'],
  ['--color-status-success', '--color-bg-primary', 'status'],
  ['--color-status-warning', '--color-bg-primary', 'status'],
  ['--color-status-error', '--color-bg-primary', 'status'],
  ['--color-status-info', '--color-bg-primary', 'status'],
  ['--color-status-neutral', '--color-bg-primary', 'status'],
  ['--color-text-primary', '--color-modal-bg'],
  ['--color-text-primary', '--color-card-bg'],
  ['--color-text-secondary', '--color-card-nested-bg'],
];

// Non-text UI (3:1 — WCAG 1.4.11)
const UI_ON_SURFACES = [
  ['--color-focus-ring', '--color-bg-primary'],
  ['--color-focus-ring', '--color-surface-primary'],
  // The ring components actually paint (Select trigger, tabs, settings rows) — alpha
  // composited over the surface it sits on.
  ['--color-focus-ring-subtle', '--color-bg-primary', 'strict'],
  ['--color-focus-ring-subtle', '--color-surface-primary', 'strict'],
  ['--color-input-focus', '--color-input-bg'],
  ['--color-input-border', '--color-input-bg', 'strict'],
  ['--color-border-focus', '--color-bg-primary'],
  ['--color-interactive-primary', '--color-bg-primary'],
  ['--color-scrollbar-thumb', '--color-scrollbar-track', 'strict'],
  ['--color-terminal-cursor', '--color-terminal-bg'],
];

const TERMINAL_FG = [
  'fg', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue',
  'bright-magenta', 'bright-cyan', 'bright-white',
].map((n) => `--color-terminal-${n}`);

function measure(tokens, fgName, bgName) {
  const bg = composite(color(tokens, bgName), composite(color(tokens, '--color-bg-primary'), null));
  const fg = composite(color(tokens, fgName), bg);
  if (!fg || !bg) return null;
  return { fg, bg, ratio: contrast(fg, bg) };
}

function runTheme(theme, blocks, opts) {
  const gate = GATED_THEMES[theme] ?? null;
  const bodyMin = gate?.body ?? 4.5;
  const uiMin = gate?.ui ?? 3;
  const terminalMin = gate?.terminal ?? 4.5;
  const statusMin = gate?.status ?? bodyMin;
  // Ungated themes get the full report; gated themes without strictUi keep the
  // hairline rows visible but informational.
  const strictUi = gate ? Boolean(gate.strictUi) : true;
  const results = [];
  const variants = [['', false], [' + high-contrast', true]];
  for (const [suffix, hc] of variants) {
    const tokens = tokensFor(blocks, theme, hc);
    const push = (kind, fgName, bgName, min, tag) => {
      const info = tag === 'strict' && !strictUi;
      const m = measure(tokens, fgName, bgName);
      if (!m) {
        results.push({ variant: suffix, kind, fg: fgName, bg: bgName, ratio: null, min, pass: info, missing: true, info });
        return;
      }
      const pass = m.ratio >= min - 1e-9;
      results.push({ variant: suffix, kind, fg: fgName, bg: bgName, ratio: m.ratio, min, pass: info || pass, below: !pass, info, fgHex: hex(m.fg), bgHex: hex(m.bg) });
    };
    for (const [fg, bg, tag] of TEXT_ON_SURFACES) push('text', fg, bg, tag === 'status' ? statusMin : bodyMin, tag);
    for (const [fg, bg, tag] of UI_ON_SURFACES) push('ui', fg, bg, uiMin, tag);
    if (hc) {
      // The High contrast toggle promises AAA (7:1) for the muted family (PR #362).
      for (const fg of ['--color-text-muted', '--color-text-interactive-muted', '--color-text-navigation-muted', '--color-text-navigation-section']) {
        push('text-aaa', fg, '--color-bg-primary', Math.max(7, bodyMin));
      }
    }
    for (const fg of TERMINAL_FG) push('terminal', fg, '--color-terminal-bg', terminalMin);
    if (!hc) {
      // Disabled text is exempt from 1.4.3 but must still be perceivable: report only.
      const m = measure(tokens, '--color-text-disabled', '--color-bg-primary');
      if (m) results.push({ variant: suffix, kind: 'info', fg: '--color-text-disabled', bg: '--color-bg-primary', ratio: m.ratio, min: 0, pass: true, info: true, fgHex: hex(m.fg), bgHex: hex(m.bg) });
    }
  }

  let cvd = null;
  if (opts.cvd || gate?.cvd) cvd = runCvd(tokensFor(blocks, theme, false));
  return { theme, gate, bodyMin, uiMin, terminalMin, statusMin, results, cvd };
}

// Semantic pairs that must stay distinguishable for every CVD type.
const CVD_SETS = [
  { name: 'status', bg: '--color-bg-primary', tokens: ['--color-status-success', '--color-status-warning', '--color-status-error', '--color-status-info'] },
  { name: 'diff-text', bg: '--color-bg-editor', tokens: ['--color-status-success', '--color-status-error'] },
  // The actual diff line backgrounds (git-diff-view tints), where defined by the theme.
  { name: 'diff-bg', bg: '--color-bg-editor', tokens: ['--color-diff-add-bg', '--color-diff-del-bg'], optional: true },
  { name: 'diff-gutter', bg: '--color-bg-editor', tokens: ['--color-diff-add-gutter', '--color-diff-del-gutter'], optional: true },
  { name: 'ansi', bg: '--color-terminal-bg', tokens: ['--color-terminal-red', '--color-terminal-green', '--color-terminal-yellow', '--color-terminal-blue', '--color-terminal-magenta', '--color-terminal-cyan'] },
  { name: 'ansi-bright', bg: '--color-terminal-bg', tokens: ['--color-terminal-bright-red', '--color-terminal-bright-green', '--color-terminal-bright-yellow', '--color-terminal-bright-blue', '--color-terminal-bright-magenta', '--color-terminal-bright-cyan'] },
];
const CVD_MIN_DELTA_E = 15; // CIE76; ~6× a just-noticeable difference — swatches read as different colors side by side

function runCvd(tokens) {
  const out = [];
  for (const set of CVD_SETS) {
    const bg = composite(color(tokens, set.bg), composite(color(tokens, '--color-bg-primary'), null));
    const colors = set.tokens.map((t) => [t, composite(color(tokens, t), bg)]).filter(([, c]) => c);
    if (set.optional && colors.length < set.tokens.length) continue; // theme does not define these tokens
    for (const kind of ['normal', ...Object.keys(CVD_MATRICES)]) {
      const sim = colors.map(([t, c]) => [t, kind === 'normal' ? c : simulate(c, kind)]);
      let worst = null;
      for (let i = 0; i < sim.length; i += 1) {
        for (let j = i + 1; j < sim.length; j += 1) {
          const dE = deltaE(sim[i][1], sim[j][1]);
          if (!worst || dE < worst.dE) worst = { a: sim[i][0], b: sim[j][0], dE, aHex: hex(sim[i][1]), bHex: hex(sim[j][1]) };
        }
      }
      // Also each simulated color must remain readable on the (simulated) background.
      const simBg = kind === 'normal' ? bg : simulate(bg, kind);
      const minOnBg = Math.min(...sim.map(([, c]) => contrast(c, simBg)));
      out.push({ set: set.name, kind, worst, minOnBg, pass: worst ? worst.dE >= CVD_MIN_DELTA_E : true });
    }
  }
  return out;
}

// ---------- reporting ----------

const fmt = (n) => (n === null || n === undefined ? '—' : n.toFixed(2));
const short = (name) => name.replace(/^--color-/, '');

function printText(report, showAll) {
  const { theme, gate, results, cvd } = report;
  const failures = results.filter((r) => !r.pass);
  const statusNote = gate && report.statusMin !== report.bodyMin ? `, status ≥ ${report.statusMin}:1` : '';
  console.log(`\n== ${theme}${gate ? ` (gated: text ≥ ${report.bodyMin}:1, UI ≥ ${report.uiMin}:1, terminal ≥ ${report.terminalMin}:1${statusNote}${gate.strictUi ? ', hairlines gated' : ''})` : ' (report only)'} ==`);
  for (const r of results) {
    if (!showAll && r.pass && !r.below) continue;
    const status = r.missing ? (r.info ? 'n/a ' : 'MISSING') : r.info ? (r.below ? 'low ' : 'ok  ') : r.pass ? 'ok  ' : 'FAIL';
    const note = r.info && r.below ? '  (report only)' : '';
    console.log(`  ${status} ${r.kind.padEnd(8)} ${short(r.fg).padEnd(34)} on ${short(r.bg).padEnd(30)} ${fmt(r.ratio).padStart(6)}:1  (min ${r.min})${r.variant}${note}`);
  }
  const gated = results.filter((r) => !r.info);
  console.log(`  ${gated.length - failures.length}/${gated.length} checks pass`);
  if (cvd) {
    console.log('  CVD simulation (Machado 2009, severity 1.0) — worst pair ΔE (CIE76), min contrast on bg:');
    const cvdGated = Boolean(gate?.cvd);
    for (const row of cvd) {
      const status = row.pass ? 'ok  ' : cvdGated ? 'FAIL' : 'low ';
      console.log(`  ${status} ${row.set.padEnd(12)} ${row.kind.padEnd(13)} ΔE ${fmt(row.worst?.dE).padStart(6)}  (${short(row.worst?.a ?? '')} vs ${short(row.worst?.b ?? '')})  min ${fmt(row.minOnBg)}:1`);
    }
  }
}

function printMarkdown(report) {
  const { theme, results, cvd } = report;
  const base = results.filter((r) => r.variant === '');
  const pick = (fg, bg) => base.find((r) => r.fg === fg && r.bg === bg);
  const row = (label, fg, bg) => {
    const r = pick(fg, bg);
    if (!r) return null;
    return `| ${label} | \`${r.fgHex}\` on \`${r.bgHex}\` | ${fmt(r.ratio)}:1 | ${r.pass ? '✅' : '❌'} |`;
  };
  console.log(`\n#### ${theme} — measured contrast (WCAG 2.x)\n`);
  console.log('| Pair | Colors | Ratio | Pass |');
  console.log('|---|---|---|---|');
  const rows = [
    row('Body text / bg', '--color-text-primary', '--color-bg-primary'),
    row('Body text / editor', '--color-text-primary', '--color-bg-editor'),
    row('Secondary text / bg', '--color-text-secondary', '--color-bg-primary'),
    row('Tertiary text / bg', '--color-text-tertiary', '--color-bg-primary'),
    row('Muted text / bg', '--color-text-muted', '--color-bg-primary'),
    row('Sidebar text / sidebar', '--color-text-navigation-primary', '--color-surface-navigation'),
    row('Sidebar muted / sidebar', '--color-text-navigation-muted', '--color-surface-navigation'),
    row('Link text / bg', '--color-interactive-text', '--color-bg-primary'),
    row('Primary button', '--color-button-primary-text', '--color-button-primary-bg'),
    row('Secondary button', '--color-button-secondary-text', '--color-button-secondary-bg'),
    row('Input text / input', '--color-input-text', '--color-input-bg'),
    row('Placeholder / input', '--color-input-placeholder', '--color-input-bg'),
    row('Success / bg', '--color-status-success', '--color-bg-primary'),
    row('Warning / bg', '--color-status-warning', '--color-bg-primary'),
    row('Error / bg', '--color-status-error', '--color-bg-primary'),
    row('Info / bg', '--color-status-info', '--color-bg-primary'),
    row('Text on success chip', '--color-text-on-status-success', '--color-status-success'),
    row('Text on error chip', '--color-text-on-status-error', '--color-status-error'),
    row('Focus ring / bg (UI 3:1)', '--color-focus-ring', '--color-bg-primary'),
    row('Terminal fg / terminal bg', '--color-terminal-fg', '--color-terminal-bg'),
  ].filter(Boolean);
  for (const r of rows) console.log(r);
  const term = base.filter((r) => r.kind === 'terminal' && r.fg !== '--color-terminal-fg');
  const worstTerm = term.reduce((acc, r) => (acc === null || r.ratio < acc.ratio ? r : acc), null);
  if (worstTerm) console.log(`| Terminal ANSI (worst of 15) | \`${worstTerm.fgHex}\` (${short(worstTerm.fg)}) on \`${worstTerm.bgHex}\` | ${fmt(worstTerm.ratio)}:1 | ${worstTerm.pass ? '✅' : '❌'} |`);
  const gatedBase = base.filter((r) => !r.info);
  const total = gatedBase.length;
  const passing = gatedBase.filter((r) => r.pass).length;
  const hc = results.filter((r) => r.variant !== '');
  const hcPassing = hc.filter((r) => r.pass).length;
  console.log(`\n${passing}/${total} token pairs pass at this theme's thresholds; ${hcPassing}/${hc.length} with High contrast on.`);
  if (cvd) {
    console.log(`\n#### ${theme} — CVD simulation (Machado 2009, severity 1.0; worst pairwise ΔE, CIE76)\n`);
    console.log('| Set | Normal | Protanopia | Deuteranopia | Tritanopia |');
    console.log('|---|---|---|---|---|');
    for (const setName of [...new Set(cvd.map((c) => c.set))]) {
      const cells = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'].map((k) => {
        const r = cvd.find((c) => c.set === setName && c.kind === k);
        return r ? `${fmt(r.worst?.dE)} ${r.pass ? '✅' : '❌'}` : '—';
      });
      console.log(`| ${setName} | ${cells.join(' | ')} |`);
    }
    console.log(`\nΔE ≥ ${CVD_MIN_DELTA_E} between every pair in a set is the pass bar (below that two swatches read as the same color at a glance).`);
  }
}

// ---------- main ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const themesArg = args.find((a) => a.startsWith('--themes='))?.slice('--themes='.length)
  ?? (args.includes('--themes') ? args[args.indexOf('--themes') + 1] : null);
const showAll = flag('--verbose');
const markdown = flag('--markdown');
const cvd = flag('--cvd');

const css = readFileSync(COLORS_CSS, 'utf8');
const blocks = parseBlocks(css);
const themes = flag('--all')
  ? Object.keys(THEME_CLASSES)
  : themesArg
    ? themesArg.split(',').map((t) => t.trim()).filter(Boolean)
    : Object.keys(GATED_THEMES);
const unknown = themes.filter((t) => !THEME_CLASSES[t]);
if (unknown.length) {
  console.error(`Unknown theme(s): ${unknown.join(', ')}. Known: ${Object.keys(THEME_CLASSES).join(', ')}`);
  process.exit(2);
}

let failed = false;
const reportOnly = flag('--all');
for (const theme of themes) {
  const report = runTheme(theme, blocks, { cvd });
  if (markdown) printMarkdown(report);
  else printText(report, showAll);
  if (report.gate && !reportOnly) {
    if (report.results.some((r) => !r.pass)) failed = true;
    if (report.gate.cvd && report.cvd?.some((r) => !r.pass)) failed = true;
  }
}
if (failed) {
  console.error('\nTheme contrast gate FAILED.');
  process.exit(1);
}
