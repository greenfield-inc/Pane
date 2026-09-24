// A read-only copy of the title bar and sidebar that index.html paints before
// any JavaScript bundle loads, so a cold start shows the app instead of a blank
// window. React's own sidebar replaces it once sessions have loaded.
//
// The copy is the app's real markup with the per-launch state stripped: a
// launch opens on Home, so no pane row is selected and the title bar is empty.

export const STATIC_SHELL_STORAGE_KEY = 'pane.staticShell.v1';
export const STATIC_SHELL_ELEMENT_ID = 'static-shell';

const SAVE_DELAY_MS = 5000;
const MAX_HTML_LENGTH = 1_000_000;

export function buildStaticShellHtml(appShell: Element): string | null {
  const shell = appShell.cloneNode(true);
  if (!(shell instanceof Element)) return null;
  const layout = shell.querySelector('.pane-main-layout');
  if (!layout) return null;

  for (const child of Array.from(layout.children)) {
    if (!child.classList.contains('pane-sidebar-slot')) child.remove();
  }
  shell.querySelector('[data-testid="window-title-bar-label"]')?.parentElement?.remove();
  for (const current of Array.from(shell.querySelectorAll('[aria-current="page"]'))) {
    current.removeAttribute('aria-current');
    current.parentElement?.classList.remove('bg-surface-selected');
  }

  const html = shell.outerHTML;
  return html.length <= MAX_HTML_LENGTH ? html : null;
}

/**
 * Saves the shell a few seconds after the title bar or sidebar changes. Quit
 * ends in app.exit(), which skips pagehide, so saving on the way out is not an
 * option.
 */
export function startStaticShellSnapshots(): () => void {
  const appShell = document.querySelector('#root .pane-app-shell');
  if (!appShell) return () => {};

  let timer: number | undefined;
  const save = () => {
    timer = undefined;
    const html = buildStaticShellHtml(appShell);
    try {
      if (html) localStorage.setItem(STATIC_SHELL_STORAGE_KEY, JSON.stringify({ v: 1, html }));
    } catch {
      // Storage full or unavailable: the next launch paints no shell, as before.
    }
  };
  const schedule = () => {
    timer ??= window.setTimeout(save, SAVE_DELAY_MS);
  };

  const observer = new MutationObserver(schedule);
  for (const target of appShell.querySelectorAll('[data-testid="window-title-bar"], .pane-sidebar-slot')) {
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  schedule();

  return () => {
    observer.disconnect();
    window.clearTimeout(timer);
  };
}

export function removeStaticShell(): void {
  document.getElementById(STATIC_SHELL_ELEMENT_ID)?.remove();
}
