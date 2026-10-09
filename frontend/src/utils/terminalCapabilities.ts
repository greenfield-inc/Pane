import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import type { IImageAddonOptions } from '@xterm/addon-image';
import { TERMINAL_IMAGE_OPTIONS } from '../../../shared/constants/terminalGraphics';
import { devLog } from './console';

/**
 * The terminal capabilities every Pane renderer must agree on.
 *
 * Pane draws the same PTY in more than one place — the session's terminal
 * panel and, since Mission Control, a grid tile. The agent on the other end
 * cannot tell them apart: it negotiated a screen once, and every renderer of
 * that screen has to honour the same answers. Two of these are silent when
 * they disagree, which is why they live in one place rather than being set at
 * each call site:
 *
 * - **Unicode 11 widths.** A renderer left on xterm's Unicode 6 default gives
 *   a wide emoji one cell where the PTY gave it two. Nothing looks broken at
 *   the point of the emoji; every absolutely-positioned repaint *after* it
 *   lands a column off.
 * - **Inline images.** `@xterm/addon-image` is what answers the sixel, iTerm2
 *   and kitty graphics protocols. A renderer without it does not degrade to a
 *   placeholder — the escape sequence falls through as nothing, so the tool
 *   reports images unsupported or paints blank space.
 *
 * The kitty keyboard protocol is a user setting rather than a fixed
 * capability, so it is passed in; everything else is the same everywhere.
 *
 * `TERMINAL_IMAGE_OPTIONS` is shared with `runpane doctor`, so what Pane
 * advertises and what it configures cannot drift.
 */

const IMAGE_ADDON_OPTIONS: IImageAddonOptions = TERMINAL_IMAGE_OPTIONS;

/** The constructor options every terminal Pane renders a PTY into shares. */
export interface TerminalCapabilityOptions {
  allowProposedApi: true;
  vtExtensions: { kittyKeyboard: boolean; win32InputMode: true };
}

export function terminalCapabilityOptions(kittyKeyboard: boolean): TerminalCapabilityOptions {
  return {
    // Unlocks terminal.unicode, which Unicode11Addon needs. Without it that
    // addon throws on load and the terminal silently falls back to Unicode 6
    // cell widths.
    allowProposedApi: true,
    vtExtensions: { kittyKeyboard, win32InputMode: true },
  };
}

/** The part of xterm's `Terminal` these addons touch. */
interface CapableTerminal {
  loadAddon: Terminal['loadAddon'];
  unicode: { activeVersion: string };
}

/**
 * How the addons are fetched. Injected so the wiring can be tested without a
 * DOM: the real loaders are dynamic imports of modules that construct
 * canvases on load.
 */
export interface TerminalCapabilityLoaders {
  unicode11: () => Promise<new () => ITerminalAddon>;
  image: () => Promise<new (options: IImageAddonOptions) => ITerminalAddon>;
}

const defaultLoaders: TerminalCapabilityLoaders = {
  unicode11: async () => (await import('@xterm/addon-unicode11')).Unicode11Addon,
  image: async () => (await import('@xterm/addon-image')).ImageAddon,
};

export interface TerminalCapabilityRequest {
  /** Named in warnings, so a failed load says which terminal lost what. */
  label: string;
  /**
   * Load the image addon.
   *
   * On for anything the user can read a running agent in. Off only where the
   * renderer is not a screen — the addon decodes and stores frames per
   * terminal, and a body that is never looked at should not pay for them.
   */
  images: boolean;
  /** Whether the terminal went away while an addon was still being fetched. */
  isStale?: () => boolean;
  loaders?: TerminalCapabilityLoaders;
}

export interface LoadedTerminalCapabilities {
  /** Dispose every addon that loaded, in reverse order of loading. */
  dispose(): void;
}

/**
 * Load the shared capabilities onto a terminal that was constructed with
 * `terminalCapabilityOptions`.
 *
 * A capability that fails to load is a degraded terminal, not a broken one, so
 * each load is guarded on its own: an addon missing from a packaged build must
 * not take the terminal with it.
 */
export async function loadTerminalCapabilities(
  terminal: CapableTerminal,
  { label, images, isStale, loaders = defaultLoaders }: TerminalCapabilityRequest,
): Promise<LoadedTerminalCapabilities> {
  const loaded: ITerminalAddon[] = [];
  const stale = () => isStale?.() ?? false;

  try {
    const Unicode11Addon = await loaders.unicode11();
    if (!stale()) {
      const addon = new Unicode11Addon();
      terminal.loadAddon(addon);
      terminal.unicode.activeVersion = '11';
      loaded.push(addon);
      devLog.debug('[terminalCapabilities] Unicode11Addon loaded for', label);
    }
  } catch (e) {
    console.warn('[terminalCapabilities] Unicode11Addon failed to load for', label, ':', e);
  }

  if (images) {
    try {
      const ImageAddon = await loaders.image();
      if (!stale()) {
        const addon = new ImageAddon(IMAGE_ADDON_OPTIONS);
        terminal.loadAddon(addon);
        loaded.push(addon);
        devLog.debug('[terminalCapabilities] ImageAddon loaded for', label);
      }
    } catch (e) {
      console.warn('[terminalCapabilities] ImageAddon failed to load for', label, ':', e);
    }
  }

  return {
    dispose() {
      for (const addon of loaded.reverse()) {
        try {
          addon.dispose();
        } catch {
          // A terminal disposed first takes its addons with it; that is the
          // usual reason this throws, and it is not worth reporting.
        }
      }
      loaded.length = 0;
    },
  };
}
