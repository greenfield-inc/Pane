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
/** A mounted chat waiting to take the box: for its own box to settle, or an IME composition to end. */
let waiting: (() => void) | null = null;
/** Stops what revealApp set up to drop the outline. */
let stopWatching = () => {};

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
  stopWatching = () => {
    clearTimeout(timer);
    window.removeEventListener('mousedown', leave, true);
  };
}

function remove(root: HTMLElement): void {
  stopWatching();
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

/** How long a mounted chat waits for its box to reach the outline box's place before taking over anyway. */
const SETTLE_MS = 500;

/**
 * The chat tab `panelId` is mounting: `apply` gets its share of the launch outline, if any. The
 * outline goes in the frame where the chat's box (`chatBox`) first sits exactly where the outline's
 * box is: a mounting tab lays out at zero width first. An IME composition in the box finishes
 * there first. Returns a cleanup for a tab that unmounts before then.
 */
export function takeLaunchDraft(panelId: string, chatBox: () => HTMLElement | null, apply: (draft: LaunchDraft) => void): () => void {
  const root = outline();
  const box = launchBox();
  if (!root || box?.dataset.launchComposer !== panelId) {
    if (held?.panelId === panelId) {
      const { draft } = held;
      held = null;
      apply(draft);
    }
    return () => undefined;
  }
  let frame = 0;
  let observer: ResizeObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (waiting === handOver) waiting = null;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    clearTimeout(timer);
    box.removeEventListener('compositionend', check);
  };
  const handOver = (): void => {
    stop();
    apply({
      text: box.value,
      selectionStart: box.selectionStart,
      selectionEnd: box.selectionEnd,
      focused: document.activeElement === box,
      send: box.dataset.send === 'pending' && !!box.value.trim(),
    });
    remove(root);
  };
  const inPlace = () => {
    const chat = chatBox()?.getBoundingClientRect();
    const outlined = box.getBoundingClientRect();
    return !!chat && Math.abs(chat.x - outlined.x) <= 1 && Math.abs(chat.y - outlined.y) <= 1
      && Math.abs(chat.width - outlined.width) <= 1 && Math.abs(chat.height - outlined.height) <= 1;
  };
  // Run after layout and before paint (a layout effect, a resize observation, a frame), so the swap shows in one frame.
  const check = (): void => {
    if (box.dataset.composing === 'true') return;
    if (inPlace()) handOver();
  };
  const everyFrame = () => {
    check();
    if (waiting === handOver) frame = requestAnimationFrame(everyFrame);
  };
  waiting = handOver;
  check();
  if (waiting !== handOver) return () => undefined;
  const target = chatBox();
  if (target) {
    observer = new ResizeObserver(check);
    observer.observe(target);
  }
  frame = requestAnimationFrame(everyFrame);
  // After the input method's own handler (index.html), so the text is final.
  box.addEventListener('compositionend', check);
  timer = setTimeout(() => { if (box.dataset.composing !== 'true') handOver(); }, SETTLE_MS);
  return stop;
}
