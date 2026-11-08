import { describe, expect, it } from 'vitest';
import { alignGuestColorScheme, guestColorSchemeScript, type SchemeGuestWindow } from './guestColorScheme';

/** A page with a sheet-level media query, a top-level rule and a nested one, on a Mac set to `osDark`. */
function page(osDark: boolean) {
  const listeners: Array<() => void> = [];
  const query = { matches: osDark, addEventListener: (_type: 'change', listener: () => void) => { listeners.push(listener); } };
  const sheetMedia = { mediaText: '(prefers-color-scheme: light)' };
  const top = { media: { mediaText: '(prefers-color-scheme: dark)' } };
  const nested = { media: { mediaText: 'screen and (prefers-color-scheme:dark)' } };
  const plain = { media: { mediaText: 'print' } };
  const view: SchemeGuestWindow = {
    document: { styleSheets: [{ media: sheetMedia, cssRules: [top, { cssRules: [nested] }, plain, {}] }] },
    matchMedia: () => query,
  };
  const texts = () => [sheetMedia.mediaText, top.media.mediaText, nested.media.mediaText, plain.media.mediaText];
  const macChanges = (dark: boolean) => { query.matches = dark; listeners.forEach(listener => listener()); };
  return { view, texts, macChanges, listeners };
}

const ORIGINAL = ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)', 'screen and (prefers-color-scheme:dark)', 'print'];
const SWAPPED = ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)', 'screen and (prefers-color-scheme:light)', 'print'];

describe('alignGuestColorScheme (D-163)', () => {
  it('leaves the page alone when the Mac already matches Pane', () => {
    const { view, texts } = page(true);
    alignGuestColorScheme(view, 'dark');
    expect(texts()).toEqual(ORIGINAL);
  });

  it("swaps the page's scheme rules when Pane is dark and the Mac is light, and back when Pane turns light", () => {
    const { view, texts } = page(false);
    alignGuestColorScheme(view, 'dark');
    expect(texts()).toEqual(SWAPPED);
    alignGuestColorScheme(view, 'dark');
    expect(texts()).toEqual(SWAPPED);
    alignGuestColorScheme(view, 'light');
    expect(texts()).toEqual(ORIGINAL);
  });

  it('follows the Mac changing while the page is open, listening once', () => {
    const { view, texts, macChanges, listeners } = page(false);
    alignGuestColorScheme(view, 'dark');
    alignGuestColorScheme(view, 'dark');
    expect(listeners).toHaveLength(1);
    macChanges(true);
    expect(texts()).toEqual(ORIGINAL);
    macChanges(false);
    expect(texts()).toEqual(SWAPPED);
  });

  it('skips a stylesheet it cannot read', () => {
    const { view, texts } = page(false);
    const unreadable = { get cssRules(): never { throw new Error('cross-origin'); } };
    view.document.styleSheets = [unreadable, ...Array.from(view.document.styleSheets)];
    alignGuestColorScheme(view, 'dark');
    expect(texts()).toEqual(SWAPPED);
  });

  it('serialises into a self-contained script for the guest', () => {
    const { view, texts } = page(false);
    const script = guestColorSchemeScript('dark');
    // Runs the serialised script the way the guest will, with its own window.
    new Function('window', script)(view);
    expect(texts()).toEqual(SWAPPED);
  });
});
