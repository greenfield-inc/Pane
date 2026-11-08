export type ColorScheme = 'light' | 'dark';

/** The CSSOM parts the guest script touches, so a test can hand it plain objects. */
interface SchemeMediaList { mediaText: string }
interface SchemeRule { media?: SchemeMediaList; cssRules?: ArrayLike<SchemeRule> }
interface SchemeSheet { media?: SchemeMediaList; cssRules: ArrayLike<SchemeRule> }
interface SchemeQuery { matches: boolean; addEventListener(type: 'change', listener: () => void): void }
export interface SchemeGuestWindow {
  document: { styleSheets: ArrayLike<SchemeSheet> };
  matchMedia(query: string): SchemeQuery;
  __paneColorScheme?: { want: ColorScheme; inverted: boolean };
}

/**
 * D-163: a page in a <webview> follows Pane's light or dark, not the Mac's. Pane points Electron's
 * nativeTheme at its theme, which every guest's prefers-color-scheme follows, so this usually does
 * nothing. When the two differ (System mode with, say, a dark palette for the Mac's light setting),
 * it swaps dark and light in the page's prefers-color-scheme rules, and swaps back when they agree
 * again, including when the Mac changes while the page is open.
 *
 * It runs inside the guest page (serialised into executeJavaScript), so it must not use anything
 * from outside its own body. It replaces an attached webContents.debugger, which crashed Pane when
 * the webview closed (electron/electron#53376).
 */
export function alignGuestColorScheme(view: SchemeGuestWindow, want: ColorScheme): void {
  const swapText = (list: SchemeMediaList | undefined): void => {
    if (!list || !list.mediaText.includes('prefers-color-scheme')) return;
    list.mediaText = list.mediaText.replace(/(prefers-color-scheme\s*:\s*)(dark|light)/g,
      (_match: string, feature: string, value: string) => feature + (value === 'dark' ? 'light' : 'dark'));
  };
  const swapRules = (rules: ArrayLike<SchemeRule> | undefined): void => {
    if (!rules) return;
    for (let i = 0; i < rules.length; i += 1) {
      swapText(rules[i].media);
      swapRules(rules[i].cssRules);
    }
  };
  const swapAll = (): void => {
    const sheets = view.document.styleSheets;
    for (let i = 0; i < sheets.length; i += 1) {
      swapText(sheets[i].media);
      // A cross-origin stylesheet throws on cssRules; it keeps the Mac's scheme.
      try { swapRules(sheets[i].cssRules); } catch { /* unreadable sheet */ }
    }
  };
  const query = view.matchMedia('(prefers-color-scheme: dark)');
  const sync = (): void => {
    const state = view.__paneColorScheme;
    if (!state) return;
    const invert = (query.matches ? 'dark' : 'light') !== state.want;
    if (invert === state.inverted) return;
    swapAll();
    state.inverted = invert;
  };
  if (!view.__paneColorScheme) {
    view.__paneColorScheme = { want, inverted: false };
    query.addEventListener('change', sync);
  }
  view.__paneColorScheme.want = want;
  sync();
}

/** The script a <webview>'s executeJavaScript runs to give its page Pane's scheme. */
export function guestColorSchemeScript(want: ColorScheme): string {
  return `(${alignGuestColorScheme.toString()})(window, ${JSON.stringify(want)});`;
}
