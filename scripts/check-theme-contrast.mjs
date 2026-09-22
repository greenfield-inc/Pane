#!/usr/bin/env node
/**
 * One browser-computed contrast gate for every theme's muted family, the full
 * editorial matrix, and the batch themes' text/UI/terminal/CVD profiles.
 * Chromium resolves the real CSS cascade and var() expressions; the remaining
 * code measures WCAG contrast, CVD separation, and prints CLI/PR reports.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { THEME_CLASSES } from '../shared/types/appearance.ts';

const COLORS_CSS = new URL('../frontend/src/styles/tokens/colors.css', import.meta.url);
const EDITORIAL_THEMES = ['folio', 'newsprint', 'walnut'];
const MUTED_FAMILY = ['--color-text-muted', '--color-text-interactive-muted', '--color-text-navigation-muted', '--color-text-navigation-section'];

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

// The browser owns CSS parsing, specificity, source order, variable resolution,
// and color syntax. No app/server/network access is needed for this measurement.
async function readThemeStyles(page, theme) {
  return page.evaluate(({ classes, theme }) => {
    const root = document.documentElement;
    const probe = document.createElement('span');
    root.append(probe);
    const snapshots = [];
    for (const highContrast of [false, true]) {
      root.className = [...classes, ...(highContrast ? ['high-contrast'] : [])].join(' ');
      const styles = getComputedStyle(root);
      const tokens = [];
      for (const name of styles) {
        if (!name.startsWith('--color-') || name.endsWith('-rgb')) continue;
        if (!CSS.supports('color', styles.getPropertyValue(name))) throw new Error(`Invalid color token ${name}`);
        probe.style.color = `var(${name})`;
        tokens.push([name, getComputedStyle(probe).color]);
      }
      snapshots.push(tokens);
    }
    probe.remove();
    // Full editorial themes promise explicit overrides. Use CSSOM declarations
    // for that contract; inherited values alone cannot demonstrate ownership.
    const declared = (selector) => [...document.styleSheets].flatMap((sheet) =>
      [...sheet.cssRules].flatMap((rule) =>
        rule instanceof CSSStyleRule && rule.selectorText.split(',').map((part) => part.trim()).includes(selector)
          ? [...rule.style].filter((name) => name.startsWith('--')) : []));
    const expected = new Set([...declared(':root.light'), ...declared(':root.terracotta')]);
    const own = new Set(declared(`:root.${theme}`));
    return { snapshots, missing: [...expected].filter((name) => !own.has(name)) };
  }, { classes: THEME_CLASSES[theme], theme });
}

// ---------- color math ----------

function parseColor(raw) {
  const value = raw.trim();
  const m = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

function color(tokens, name) {
  const value = tokens.get(name);
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

function runTheme(theme, styles, opts) {
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
    const tokens = new Map(styles.snapshots[hc ? 1 : 0]);
    const push = (kind, fgName, bgName, min, tag) => {
      const info = (tag === 'strict' && !strictUi) || (!gate && tag !== 'global');
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
    // This baseline applies to all 27 themes, including the original twelve.
    for (const fg of MUTED_FAMILY) {
      push(hc ? 'text-aaa' : 'text-aa', fg, '--color-bg-primary', hc ? 7 : 4.5, 'global');
    }
    if (!hc && EDITORIAL_THEMES.includes(theme)) {
      // Preserve the broader surface/button matrix previously gated by Vitest.
      for (const bg of ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-hover', 'bg-active', 'bg-chrome', 'bg-editor', 'surface-primary', 'surface-secondary', 'surface-tertiary', 'card-bg', 'card-nested-bg', 'modal-bg', 'input-bg', 'surface-navigation', 'surface-navigation-hover']) {
        for (const fg of ['primary', 'secondary', 'tertiary', 'muted']) push('text', `--color-text-${fg}`, `--color-${bg}`, 4.5);
      }
      for (const bg of ['surface-navigation', 'surface-navigation-hover', 'surface-navigation-active']) {
        for (const fg of ['primary', 'secondary', 'muted', 'selected', 'section']) push('text', `--color-text-navigation-${fg}`, `--color-${bg}`, 4.5);
      }
      for (const bg of ['bg-primary', 'bg-editor', 'bg-chrome', 'surface-primary']) {
        for (const fg of ['interactive-text', 'text-interactive-on-dark']) push('text', `--color-${fg}`, `--color-${bg}`, 4.5);
        for (const fg of ['status-neutral', 'interactive-primary', 'focus-ring', 'border-focus', 'status-success', 'status-warning', 'status-error', 'status-info']) push('ui', `--color-${fg}`, `--color-${bg}`, 3);
      }
      for (const bg of ['interactive-hover', 'interactive-active']) push('text', '--color-text-on-interactive', `--color-${bg}`, 4.5);
    }
    for (const fg of TERMINAL_FG) push('terminal', fg, '--color-terminal-bg', terminalMin);
    if (!hc) {
      // Disabled text is exempt from 1.4.3 but must still be perceivable: report only.
      const m = measure(tokens, '--color-text-disabled', '--color-bg-primary');
      if (m) results.push({ variant: suffix, kind: 'info', fg: '--color-text-disabled', bg: '--color-bg-primary', ratio: m.ratio, min: 0, pass: true, info: true, fgHex: hex(m.fg), bgHex: hex(m.bg) });
    }
  }

  let cvd = null;
  if (opts.cvd || gate?.cvd) cvd = runCvd(new Map(styles.snapshots[0]));
  const contractErrors = [];
  if (EDITORIAL_THEMES.includes(theme)) {
    if (styles.missing.length) contractErrors.push(`Missing own token overrides: ${styles.missing.join(', ')}`);
    const tokens = new Map(styles.snapshots[0]);
    if (tokens.get('--color-terminal-bg') !== tokens.get('--color-bg-editor')) {
      contractErrors.push('Terminal background must match the editor surface');
    }
  }
  return { theme, gate, bodyMin, uiMin, terminalMin, statusMin, results, cvd, contractErrors };
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
  console.log(`\n== ${theme}${gate ? ` (gated: text ≥ ${report.bodyMin}:1, UI ≥ ${report.uiMin}:1, terminal ≥ ${report.terminalMin}:1${statusNote}${gate.strictUi ? ', hairlines gated' : ''})` : ' (muted family gated; other pairs report only)'} ==`);
  for (const r of results) {
    if (!showAll && r.pass && !r.below) continue;
    const status = r.missing ? (r.info ? 'n/a ' : 'MISSING') : r.info ? (r.below ? 'low ' : 'ok  ') : r.pass ? 'ok  ' : 'FAIL';
    const note = r.info && r.below ? '  (report only)' : '';
    console.log(`  ${status} ${r.kind.padEnd(8)} ${short(r.fg).padEnd(34)} on ${short(r.bg).padEnd(30)} ${fmt(r.ratio).padStart(6)}:1  (min ${r.min})${r.variant}${note}`);
  }
  const gated = results.filter((r) => !r.info);
  console.log(`  ${gated.length - failures.length}/${gated.length} checks pass`);
  for (const error of report.contractErrors) console.log(`  FAIL ${error}`);
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
  for (const error of report.contractErrors) console.log(`\n❌ ${error}`);
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
const themes = flag('--all')
  ? Object.keys(THEME_CLASSES)
  : themesArg
    ? themesArg.split(',').map((t) => t.trim()).filter(Boolean)
    : Object.keys(THEME_CLASSES);
const unknown = themes.filter((t) => !THEME_CLASSES[t]);
if (unknown.length) {
  console.error(`Unknown theme(s): ${unknown.join(', ')}. Known: ${Object.keys(THEME_CLASSES).join(', ')}`);
  process.exit(2);
}

let failed = false;
const reportOnly = flag('--all');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.addStyleTag({ content: css });
  for (const theme of themes) {
    const report = runTheme(theme, await readThemeStyles(page, theme), { cvd });
    if (markdown) printMarkdown(report);
    else printText(report, showAll);
    if (!reportOnly) {
      if (report.results.some((r) => !r.pass) || report.contractErrors.length) failed = true;
      if (report.gate?.cvd && report.cvd?.some((r) => !r.pass)) failed = true;
    }
  }
} finally {
  await browser.close();
}
if (failed) {
  console.error('\nTheme contrast gate FAILED.');
  process.exitCode = 1;
}
