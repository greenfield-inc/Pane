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
  /**
   * When (epoch ms) the chat must have been able to send it; past it the text stays unsent with
   * why. Without it the chat waits the launch outline's default 5 s from when it takes the draft.
   */
  sendBy?: number;
}

/** How long the outline waits, from the app's start, for the app's first render and the launch chat. */
const CHAT_WAIT_MS = 10_000;

/** Text typed into the box before the person went elsewhere, waiting for that chat to mount. */
let held: { panelId: string; draft: LaunchDraft } | null = null;
/** A mounted chat waiting to take the box: for its own box to settle, or an IME composition to end. */
let waiting: (() => void) | null = null;
/** Run when the outline goes: what was set up to drop it. */
const onRemove = new Set<() => void>();

const outline = () => document.getElementById('pane-launch-outline');
const launchBox = () => outline()?.querySelector<HTMLTextAreaElement>('textarea[data-launch-composer]') ?? null;

/**
 * The app has started: the outline goes within CHAT_WAIT_MS whatever happens next, also when the
 * app never renders its data (a failed first read) or the chat never mounts.
 */
export function startLaunchOutlineFallback(): void {
  if (!outline()) return;
  const timer = setTimeout(dropLaunchOutline, CHAT_WAIT_MS);
  onRemove.add(() => clearTimeout(timer));
}

/** Runs `stop` when the outline goes; for watchers that drop it. */
export function whileLaunchOutline(stop: () => void): void {
  if (outline()) onRemove.add(stop);
  else stop();
}

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
  window.addEventListener('mousedown', leave, true);
  onRemove.add(() => window.removeEventListener('mousedown', leave, true));
}

function remove(root: HTMLElement): void {
  for (const stop of onRemove) stop();
  onRemove.clear();
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
 * there first. Another chat mounting first drops the outline. Returns a cleanup for a tab that
 * unmounts before then, which drops it too.
 */
export function takeLaunchDraft(panelId: string, chatBox: () => HTMLElement | null, apply: (draft: LaunchDraft) => void): () => void {
  const root = outline();
  const box = launchBox();
  // Another chat opened first: the person or a link went elsewhere.
  if (root && box && box.dataset.launchComposer !== panelId) dropLaunchOutline();
  if (!root || !box || box.dataset.launchComposer !== panelId) {
    if (held?.panelId === panelId) {
      const { draft } = held;
      held = null;
      apply(draft);
    }
    return () => undefined;
  }
  let frame = 0;
  let observer: ResizeObserver | null = null;
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
  // Created first: a handover from the first check below clears it.
  const timer = setTimeout(() => { if (box.dataset.composing !== 'true') handOver(); }, SETTLE_MS);
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
  return () => {
    stop();
    // The chat closed before it took over (the person moved on). React's development remount
    // registers again at once, so the check waits a microtask.
    queueMicrotask(() => { if (!waiting && launchBox()?.dataset.launchComposer === panelId) dropLaunchOutline(); });
  };
}
