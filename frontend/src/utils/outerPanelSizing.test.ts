import { describe, expect, it } from 'vitest';
import {
  OUTER_PANEL_CONFIGS,
  readOuterPanelPreference,
  resolveOuterPanelRenderPolicy,
  resolveOuterPanelSize,
  writeOuterPanelPreference,
} from './outerPanelSizing';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('outer panel sizing', () => {
  it.each([
    ['worktreeInspector', 1040, 240, 720, 360],
    ['worktreeInspector', 700, 240, 380, 360],
    ['rightTerminal', 900, 200, 580, 350],
    ['bottomDetail', 500, 80, 340, 200],
  ] as const)('resolves %s against its immediate container', (surface, container, floor, cap, effective) => {
    expect(resolveOuterPanelSize(OUTER_PANEL_CONFIGS[surface], container)).toEqual({ floor, cap, effectivePx: effective });
  });

  it('uses 32 percent of the first usable terminal height without a 500px cap', () => {
    expect(resolveOuterPanelSize(OUTER_PANEL_CONFIGS.bottomTerminal, 600)).toEqual({ floor: 100, cap: 440, effectivePx: 192 });
    expect(resolveOuterPanelSize(OUTER_PANEL_CONFIGS.bottomTerminal, 2000)).toEqual({ floor: 100, cap: 1840, effectivePx: 640 });
  });

  it.each([
    ['worktreeInspector', 415, 0, 0, false],
    ['worktreeInspector', 416, 96, 96, true],
    ['bottomTerminal', 191, 32, 32, false],
    ['bottomTerminal', 192, 32, 32, false],
    ['bottomTerminal', 223, 32, 32, false],
    ['bottomTerminal', 224, 64, 64, true],
    ['bottomDetail', 223, 32, 32, false],
    ['bottomDetail', 224, 64, 64, true],
  ] as const)('handles the %s emergency boundary at %ipx', (surface, container, floor, cap, active) => {
    const config = OUTER_PANEL_CONFIGS[surface];
    const size = resolveOuterPanelSize(config, container, 400);
    expect(size).toEqual({ floor, cap, effectivePx: cap });
    expect(resolveOuterPanelRenderPolicy(config, size, true).bodyActive).toBe(active);
  });

  it('keeps a constrained preference recoverable across shrink and regrow', () => {
    const config = OUTER_PANEL_CONFIGS.worktreeInspector;
    expect(resolveOuterPanelSize(config, 600, 650).effectivePx).toBe(280);
    expect(resolveOuterPanelSize(config, 1200, 650).effectivePx).toBe(650);
  });

  it('only offers a separator for an enabled usable adjustable range', () => {
    const config = OUTER_PANEL_CONFIGS.rightTerminal;
    expect(resolveOuterPanelRenderPolicy(config, resolveOuterPanelSize(config, 1000), true).separatorVisible).toBe(true);
    expect(resolveOuterPanelRenderPolicy(config, resolveOuterPanelSize(config, 520), true).separatorVisible).toBe(false);
    expect(resolveOuterPanelRenderPolicy(config, resolveOuterPanelSize(config, 1000), false)).toEqual({
      renderedPx: 0,
      bodyActive: false,
      separatorVisible: false,
    });
  });
});

describe('outer panel preferences', () => {
  it('prefers a valid v2 value and accepts only integer values from 1 through 8192', () => {
    const storage = new MemoryStorage();
    const config = OUTER_PANEL_CONFIGS.worktreeInspector;
    storage.setItem(config.legacyKey, '500');
    storage.setItem(config.storageKey, JSON.stringify({ version: 2, preferredPx: 640 }));
    expect(readOuterPanelPreference(config, storage)).toBe(640);

    for (const preferredPx of [0, 1.5, 8193, '400']) {
      storage.setItem(config.storageKey, JSON.stringify({ version: 2, preferredPx }));
      expect(readOuterPanelPreference(config, storage)).toBe(500);
    }
  });

  it('strictly migrates legacy values while treating the old default as ambiguous', () => {
    const storage = new MemoryStorage();
    const config = OUTER_PANEL_CONFIGS.bottomTerminal;
    for (const invalid of ['200', '200px', ' 240', '+240', '99', '501']) {
      storage.setItem(config.legacyKey, invalid);
      expect(readOuterPanelPreference(config, storage)).toBeUndefined();
    }
    storage.setItem(config.legacyKey, '240');
    expect(readOuterPanelPreference(config, storage)).toBe(240);
  });

  it('writes only the versioned key without altering legacy state', () => {
    const storage = new MemoryStorage();
    const config = OUTER_PANEL_CONFIGS.worktreeInspector;
    storage.setItem(config.legacyKey, '480');
    writeOuterPanelPreference(config, storage, 511.6);
    expect(storage.getItem(config.storageKey)).toBe('{"version":2,"preferredPx":512}');
    expect(storage.getItem(config.legacyKey)).toBe('480');
  });
});
