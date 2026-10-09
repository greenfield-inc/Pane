import { describe, expect, it, vi } from 'vitest';
import type { ITerminalAddon } from '@xterm/xterm';
import type { IImageAddonOptions } from '@xterm/addon-image';
import { TERMINAL_IMAGE_OPTIONS } from '../../../shared/constants/terminalGraphics';
import {
  loadTerminalCapabilities,
  terminalCapabilityOptions,
  type TerminalCapabilityLoaders,
} from './terminalCapabilities';

/** The two members of xterm's `Terminal` these addons touch. */
function fakeTerminal() {
  const loaded: ITerminalAddon[] = [];
  return {
    loaded,
    terminal: {
      loadAddon: (addon: ITerminalAddon) => { loaded.push(addon); },
      unicode: { activeVersion: '6' },
    },
  };
}

function recordingLoaders() {
  const imageOptions: IImageAddonOptions[] = [];
  const disposed: string[] = [];

  class FakeUnicode11Addon implements ITerminalAddon {
    activate() {}
    dispose() { disposed.push('unicode11'); }
  }
  class FakeImageAddon implements ITerminalAddon {
    constructor(options: IImageAddonOptions) { imageOptions.push(options); }
    activate() {}
    dispose() { disposed.push('image'); }
  }

  const loaders: TerminalCapabilityLoaders = {
    unicode11: async () => FakeUnicode11Addon,
    image: async () => FakeImageAddon,
  };
  return { loaders, imageOptions, disposed };
}

describe('terminalCapabilityOptions', () => {
  it('unlocks the proposed API the Unicode 11 addon needs', () => {
    // Without it the addon throws on load and the terminal falls back to
    // Unicode 6 widths, which puts every later absolute repaint a column off.
    expect(terminalCapabilityOptions(true).allowProposedApi).toBe(true);
  });

  it('carries the user kitty keyboard setting either way', () => {
    expect(terminalCapabilityOptions(true).vtExtensions).toEqual({ kittyKeyboard: true, win32InputMode: true });
    expect(terminalCapabilityOptions(false).vtExtensions).toEqual({ kittyKeyboard: false, win32InputMode: true });
  });
});

describe('loadTerminalCapabilities', () => {
  it('puts every renderer on Unicode 11 widths', async () => {
    const { terminal, loaded } = fakeTerminal();
    const { loaders } = recordingLoaders();

    await loadTerminalCapabilities(terminal, { label: 'tile', images: false, loaders });

    expect(loaded).toHaveLength(1);
    expect(terminal.unicode.activeVersion).toBe('11');
  });

  it('configures images from the options runpane doctor reports', async () => {
    const { terminal, loaded } = fakeTerminal();
    const { loaders, imageOptions } = recordingLoaders();

    await loadTerminalCapabilities(terminal, { label: 'tile', images: true, loaders });

    expect(loaded).toHaveLength(2);
    // The same object, not a copy with the same shape: what Pane advertises and
    // what it configures must not be able to drift apart.
    expect(imageOptions).toEqual([TERMINAL_IMAGE_OPTIONS]);
  });

  it('leaves images out when the caller does not want them', async () => {
    const { terminal, loaded } = fakeTerminal();
    const { loaders, imageOptions } = recordingLoaders();

    await loadTerminalCapabilities(terminal, { label: 'tile', images: false, loaders });

    expect(loaded).toHaveLength(1);
    expect(imageOptions).toEqual([]);
  });

  it('disposes what it loaded, newest first', async () => {
    const { terminal } = fakeTerminal();
    const { loaders, disposed } = recordingLoaders();

    const capabilities = await loadTerminalCapabilities(terminal, { label: 'tile', images: true, loaders });
    capabilities.dispose();

    expect(disposed).toEqual(['image', 'unicode11']);

    // Disposing twice is what a teardown race looks like, and it must not throw.
    capabilities.dispose();
    expect(disposed).toEqual(['image', 'unicode11']);
  });

  it('loads nothing onto a terminal that went away mid-fetch', async () => {
    const { terminal, loaded } = fakeTerminal();
    const { loaders } = recordingLoaders();

    await loadTerminalCapabilities(terminal, {
      label: 'tile', images: true, loaders, isStale: () => true,
    });

    expect(loaded).toEqual([]);
    expect(terminal.unicode.activeVersion).toBe('6');
  });

  it('keeps the terminal when one capability fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { terminal, loaded } = fakeTerminal();
    const { loaders } = recordingLoaders();

    const capabilities = await loadTerminalCapabilities(terminal, {
      label: 'tile',
      images: true,
      loaders: { ...loaders, image: async () => { throw new Error('not packaged'); } },
    });

    // A degraded terminal, not a broken one: Unicode 11 still landed.
    expect(loaded).toHaveLength(1);
    expect(terminal.unicode.activeVersion).toBe('11');
    expect(() => capabilities.dispose()).not.toThrow();
    warn.mockRestore();
  });
});
