import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { getCatalogEntry } from '../../../../shared/constants/keyboardShortcuts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('system-wide keys', () => {
  it('registers only the answer-all key, never the in-app Open or Close Approvals key (D-381)', () => {
    const calls = sources(join(__dirname, '../..')).flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [...text.matchAll(/globalShortcut\.register\(([^,]+),/g)].map((match) => `${path.split(/[\\/]/).pop()}: ${match[1].trim()}`);
    });
    // The one global key is the person's answer-all setting (⌃⇧Space by default).
    expect(calls).toEqual(['notifyService.ts: settings.shortcut']);
    expect(DEFAULT_NOTIFY_SETTINGS.shortcut).toBe('Control+Shift+Space');
    // ⇧⌘A is a catalog command, which the renderer runs only while Pane is in front.
    expect(getCatalogEntry('toggle-approvals')?.defaultChord).toBe('mod+shift+a');
  });
});
