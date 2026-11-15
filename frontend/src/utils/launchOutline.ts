/**
 * The launch outline (index.html): the window's first frame, drawn before the app's code loads.
 * The app's first render with data takes over the title bar and sidebar; the launch chat's tab
 * takes the message box as it mounts, with what the person typed, the caret and a pending Enter
 * (D-62). Until then the outline keeps the main area, so the box never moves or blinks out.
 */

export interface LaunchDraft {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** The box had focus, so the chat's box takes it. */
  focused: boolean;
  /** Enter was pressed: the chat sends the text once it can. */
  send: boolean;
}

/** How long the main area waits for the launch chat after the app's first render. */
const CHAT_WAIT_MS = 10_000;

/** Text typed into the box before the person went elsewhere, waiting for that chat to mount. */
let held: { panelId: string; draft: LaunchDraft } | null = null;
/** A mounted chat waiting for an IME composition in the box to end. */
let waiting: (() => void) | null = null;

const outline = () => document.getElementById('pane-launch-outline');
const launchBox = () => outline()?.querySelector<HTMLTextAreaElement>('textarea[data-launch-composer]') ?? null;

/** The app's first render with data is on screen (main has been told). */
export function revealApp(): void {
  const root = outline();
  if (!root) return;
  if (!launchBox()) {
    root.remove();
    return;
  }
  // The real title bar and sidebar show through; the main area stays until the chat mounts.
  root.style.background = 'transparent';
  root.style.pointerEvents = 'none';
  for (const part of root.querySelectorAll<HTMLElement>('[data-launch-outline]')) {
    if (part.dataset.launchOutline === 'main') {
      part.style.pointerEvents = 'auto';
    } else {
      part.style.visibility = 'hidden';
      part.style.setProperty('-webkit-app-region', 'no-drag');
    }
  }
  // A click on the real sidebar or title bar is the person going elsewhere.
  const leave = (event: MouseEvent) => {
    if (!(event.target instanceof Node) || !root.contains(event.target)) dropLaunchOutline();
  };
  const timer = setTimeout(dropLaunchOutline, CHAT_WAIT_MS);
  window.addEventListener('mousedown', leave, true);
  root.addEventListener('launch-outline-removed', () => {
    clearTimeout(timer);
    window.removeEventListener('mousedown', leave, true);
  }, { once: true });
}

function remove(root: HTMLElement): void {
  root.dispatchEvent(new Event('launch-outline-removed'));
  root.remove();
}

/** The launch chat is not opening now: the outline goes, and its text waits for that chat. */
export function dropLaunchOutline(): void {
  // The chat is already there: it takes the text now.
  if (waiting) {
    waiting();
    return;
  }
  const root = outline();
  if (!root) return;
  const box = launchBox();
  const panelId = box?.dataset.launchComposer;
  if (box && panelId && box.value) {
    held = { panelId, draft: { text: box.value, selectionStart: box.selectionStart, selectionEnd: box.selectionEnd, focused: false, send: false } };
  }
  remove(root);
}

/**
 * The chat tab `panelId` is mounting: `apply` gets its share of the launch outline, if any. Called
 * from a layout effect, so the outline goes in the same frame the chat's box first paints. An IME
 * composition in the box finishes there first: the text moves when it ends. Returns a cleanup for
 * a tab that unmounts before then.
 */
export function takeLaunchDraft(panelId: string, apply: (draft: LaunchDraft) => void): () => void {
  const root = outline();
  const box = launchBox();
  if (root && box?.dataset.launchComposer === panelId) {
    const handOver = () => {
      waiting = null;
      apply({
        text: box.value,
        selectionStart: box.selectionStart,
        selectionEnd: box.selectionEnd,
        focused: document.activeElement === box,
        send: box.dataset.send === 'pending' && !!box.value.trim(),
      });
      remove(root);
    };
    if (box.dataset.composing !== 'true') {
      handOver();
      return () => undefined;
    }
    // After the input method's own handler (index.html), so the text is final.
    const later = () => queueMicrotask(() => { if (waiting === handOver) handOver(); });
    waiting = handOver;
    box.addEventListener('compositionend', later, { once: true });
    return () => {
      if (waiting === handOver) waiting = null;
      box.removeEventListener('compositionend', later);
    };
  }
  if (held?.panelId === panelId) {
    const { draft } = held;
    held = null;
    apply(draft);
  }
  return () => undefined;
}
