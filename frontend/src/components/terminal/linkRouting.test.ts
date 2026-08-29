import { describe, expect, it, vi } from 'vitest';
import {
  classifyLinkGesture,
  describeUrlGestures,
  routeUrlActivation,
  validateBrowserUrl,
  type LinkProvider,
  type LinkRouterDeps,
} from './linkRouting';

const click = (overrides: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }> = {}) => ({
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, ...overrides,
});

function deps(overrides: Partial<LinkRouterDeps> = {}): LinkRouterDeps {
  return {
    isMac: true,
    browserAvailable: true,
    openExternal: vi.fn(() => Promise.resolve()),
    openInPaneBrowser: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const PROVIDERS: LinkProvider[] = ['osc8', 'web-links', 'git'];

describe('classifyLinkGesture', () => {
  it('uses Command on macOS and Control elsewhere as the primary modifier', () => {
    expect(classifyLinkGesture(click({ metaKey: true }), true)).toBe('external');
    expect(classifyLinkGesture(click({ ctrlKey: true }), false)).toBe('external');
    expect(classifyLinkGesture(click({ metaKey: true }), false)).toBe('none');
    expect(classifyLinkGesture(click({ metaKey: true, shiftKey: true }), false)).toBe('none');
  });

  it('gives Primary+Shift precedence', () => {
    expect(classifyLinkGesture(click({ metaKey: true, shiftKey: true }), true)).toBe('pane-browser');
    expect(classifyLinkGesture(click({ ctrlKey: true, shiftKey: true }), false)).toBe('pane-browser');
  });

  it('treats an unconsumed macOS Control primary click as external but never a shifted or secondary one', () => {
    expect(classifyLinkGesture(click({ ctrlKey: true }), true)).toBe('external');
    expect(classifyLinkGesture(click({ ctrlKey: true, button: 2 }), true)).toBe('rejected');
    expect(classifyLinkGesture(click({ ctrlKey: true, shiftKey: true }), true)).toBe('none');
  });

  it('rejects Alt and non-primary buttons outright', () => {
    expect(classifyLinkGesture(click({ metaKey: true, altKey: true }), true)).toBe('rejected');
    expect(classifyLinkGesture(click({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe('rejected');
    expect(classifyLinkGesture(click({ metaKey: true, shiftKey: true, button: 1 }), true)).toBe('rejected');
    expect(classifyLinkGesture(click({ button: 2 }), false)).toBe('rejected');
  });
});

describe('validateBrowserUrl', () => {
  it('admits only absolute credential-free HTTP(S) URLs and returns the canonical href', () => {
    expect(validateBrowserUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(validateBrowserUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(validateBrowserUrl('https://bücher.example')).toBe('https://xn--bcher-kva.example/');
    for (const rejected of [
      'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://x/y',
      'vscode://open', 'https://user:pw@example.com', 'https://', 'not a url', 'example.com',
    ]) {
      expect(validateBrowserUrl(rejected), rejected).toBeNull();
    }
  });
});

describe('routeUrlActivation', () => {
  it('opens Primary+Shift in the Pane Browser exactly once and never externally, for every provider', async () => {
    for (const provider of PROVIDERS) {
      const d = deps();
      await expect(routeUrlActivation('https://example.com', click({ metaKey: true, shiftKey: true }), provider, d)).resolves.toBe('pane-browser');
      expect(d.openInPaneBrowser).toHaveBeenCalledTimes(1);
      expect(d.openInPaneBrowser).toHaveBeenCalledWith('https://example.com/');
      expect(d.openExternal).not.toHaveBeenCalled();
    }
  });

  it('falls back externally exactly once when no Browser surface is available', async () => {
    for (const provider of PROVIDERS) {
      const d = deps({ browserAvailable: false });
      await expect(routeUrlActivation('https://example.com', click({ metaKey: true, shiftKey: true }), provider, d)).resolves.toBe('external');
      expect(d.openInPaneBrowser).not.toHaveBeenCalled();
      expect(d.openExternal).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects non-HTTP(S) URLs on every gesture-driven sink, including unavailable-surface fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const url of ['file:///tmp/x.html', 'javascript:alert(1)', 'https://user:pw@example.com', 'nope']) {
      for (const provider of PROVIDERS) {
        for (const [event, available] of [
          [click({ metaKey: true, shiftKey: true }), true],
          [click({ metaKey: true, shiftKey: true }), false],
          [click({ metaKey: true }), true],
          [click({ ctrlKey: true }), true],
        ] as const) {
          const d = deps({ browserAvailable: available });
          await expect(routeUrlActivation(url, event, provider, d)).resolves.toBe('none');
          expect(d.openInPaneBrowser).not.toHaveBeenCalled();
          expect(d.openExternal).not.toHaveBeenCalled();
        }
      }
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('opens nothing for Alt or non-primary activations, even for OSC-8', async () => {
    for (const provider of PROVIDERS) {
      const d = deps();
      await expect(routeUrlActivation('https://a', click({ altKey: true }), provider, d)).resolves.toBe('none');
      await expect(routeUrlActivation('https://a', click({ button: 1 }), provider, d)).resolves.toBe('none');
      await expect(routeUrlActivation('https://a', click({ button: 2, metaKey: true }), provider, d)).resolves.toBe('none');
      expect(d.openExternal).not.toHaveBeenCalled();
      expect(d.openInPaneBrowser).not.toHaveBeenCalled();
    }
  });

  it('keeps OSC-8 plain click opening its target as-is (pre-existing behavior)', async () => {
    const d = deps();
    await expect(routeUrlActivation('mailto:dev@example.com', click(), 'osc8', d)).resolves.toBe('external');
    expect(d.openExternal).toHaveBeenCalledWith('mailto:dev@example.com');
  });

  it('passes the canonical href to the external sink', async () => {
    const d = deps({ isMac: false });
    await routeUrlActivation('https://example.com', click({ ctrlKey: true }), 'web-links', d);
    expect(d.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('does not open externally after an in-Pane failure', async () => {
    const d = deps({ openInPaneBrowser: vi.fn(() => Promise.reject(new Error('boom'))) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(routeUrlActivation('https://example.com', click({ metaKey: true, shiftKey: true }), 'git', d)).resolves.toBe('pane-browser');
    expect(d.openExternal).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('opens Primary externally once and applies the provider plain-click policy', async () => {
    const d = deps({ isMac: false });
    await expect(routeUrlActivation('https://a', click({ ctrlKey: true }), 'web-links', d)).resolves.toBe('external');
    await expect(routeUrlActivation('https://a', click(), 'web-links', d)).resolves.toBe('none');
    await expect(routeUrlActivation('https://a', click(), 'git', d)).resolves.toBe('none');
    await expect(routeUrlActivation('https://a', click(), 'osc8', d)).resolves.toBe('external');
    // Meta alone on Windows/Linux is inert for gated providers; OSC-8 keeps its plain-click policy.
    await expect(routeUrlActivation('https://a', click({ metaKey: true }), 'web-links', d)).resolves.toBe('none');
    await expect(routeUrlActivation('https://a', click({ metaKey: true }), 'osc8', d)).resolves.toBe('external');
    expect(d.openExternal).toHaveBeenCalledTimes(3);
  });
});

describe('describeUrlGestures', () => {
  it('uses platform glyphs, provider plain-click wording, and an unavailable note', () => {
    expect(describeUrlGestures(true, true, 'web-links')).toBe('⌘+Click: external · ⇧⌘+Click: Pane Browser');
    expect(describeUrlGestures(false, true, 'git')).toBe('Ctrl+Click: external · Ctrl+Shift+Click: Pane Browser');
    expect(describeUrlGestures(true, true, 'osc8')).toBe('Click: external · ⇧⌘+Click: Pane Browser');
    expect(describeUrlGestures(false, false, 'web-links')).toBe('Ctrl+Click: external (Pane Browser unavailable here)');
    expect(describeUrlGestures(true, false, 'osc8')).toBe('Click: external (Pane Browser unavailable here)');
  });
});
