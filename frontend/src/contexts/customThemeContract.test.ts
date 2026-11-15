import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_COLOR_TOKENS } from '../../../shared/types/customTheme';
import { PANE_PARTS } from '../../../shared/types/themeGuide';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('Custom theme contract', () => {
  it('lets a Custom theme set exactly the colour tokens colors.css defines', () => {
    const css = readFileSync(join(SRC, 'styles/tokens/colors.css'), 'utf8');
    const defined = new Set([...css.matchAll(/^\s*(--color-[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
    // -rgb tokens hold bare channel triples for rgb(var(...) / alpha), not colours.
    const settable = [...defined].filter((token) => !token.endsWith('-rgb')).sort();
    expect([...THEME_COLOR_TOKENS].sort()).toEqual(settable);
  });

  it('keeps every published data-pane-part selector in the frontend source', () => {
    const source = sourceFiles(SRC).map((file) => readFileSync(file, 'utf8')).join('\n');
    const missing = PANE_PARTS.filter((part) => !source.includes(`data-pane-part="${part}"`));
    expect(missing, `custom CSS relies on these published selectors: ${missing.join(', ')}`).toEqual([]);
  });
});
