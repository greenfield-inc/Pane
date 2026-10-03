import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatKeyDisplay } from './hotkeyUtils';

describe('formatKeyDisplay', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps existing default chords unchanged on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(formatKeyDisplay('mod+shift+d')).toBe('⌘ + ⇧ + D');
    expect(formatKeyDisplay('mod+alt+ArrowLeft')).toBe('⌘ + ⌥ + ←');
    expect(formatKeyDisplay('mod+Tab')).toBe('⌘ + Tab');
    expect(formatKeyDisplay('mod+`')).toBe('⌘ + `');
  });

  it('keeps existing default chords unchanged elsewhere', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(formatKeyDisplay('mod+shift+d')).toBe('Ctrl + Shift + D');
    expect(formatKeyDisplay('mod+alt+/')).toBe('Ctrl + Alt + /');
  });

  it('renders newly recordable named keys', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(formatKeyDisplay('mod+Enter')).toBe('Ctrl + Enter');
    expect(formatKeyDisplay('shift+PageUp')).toBe('Shift + PgUp');
    expect(formatKeyDisplay('mod+Backspace')).toBe('Ctrl + Backspace');
    expect(formatKeyDisplay('mod+Space')).toBe('Ctrl + Space');
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(formatKeyDisplay('mod+Enter')).toBe('⌘ + ↩');
    expect(formatKeyDisplay('mod+Delete')).toBe('⌘ + ⌦');
  });
});
