/**
 * Keeps keyboard focus on the sidebar's cursor while a switch to another machine runs (T-128, D-6).
 *
 * Enter on a row usually moves focus into the work it opens. On another machine the work isn't
 * there until the switch lands, and the switch re-renders the sidebar and the main area meanwhile:
 * focus fell to a main-area button, then to the page body, and arrow keys stopped moving the
 * cursor (#1767's rig: 39 of 40 presses lost). The hold puts focus back on the cursor's row (found
 * again by its key when the row re-rendered) whenever the switch, not the person, moved it, so the
 * person can keep arrowing. When the switch ends with the cursor still on the pressed row, focus moves into
 * the work as Enter does elsewhere; when the cursor moved on, it stays where the person put it.
 */

/** A sidebar row as the hold uses it; an HTMLElement is one. */
interface CursorRow {
  readonly isConnected: boolean;
  getAttribute(name: string): string | null;
  focus(options?: FocusOptions): void;
}

/** What the hold needs from the page; regionFocus passes the real sidebar. */
export interface SwitchCursorHoldOptions {
  /** Settles when the switch ends, however it ends. */
  switching: Promise<unknown>;
  /** The row the sidebar cursor is on now (it moves with arrow presses). */
  cursor: () => CursorRow | null;
  /** Finds a row again after a re-render. */
  findByKey: (key: string) => CursorRow | null;
  /** The switch ended with the cursor still on the pressed row. */
  onLanded: () => void;
}

const keyOf = (element: CursorRow | null): string | null => element?.getAttribute('data-sidebar-key') ?? null;

let releaseCurrent: (() => void) | null = null;
let switchInFlight: Promise<void> | null = null;

/**
 * Marks a switch to another machine as started; call the result when it ends. A press's switch
 * starts before its first await, so Enter can see it right after clicking the row.
 */
export function beginMachineSwitch(): () => void {
  let settle!: () => void;
  const switching = new Promise<void>((resolve) => { settle = resolve; });
  switchInFlight = switching;
  return () => {
    settle();
    if (switchInFlight === switching) switchInFlight = null;
  };
}

/** The newest switch to another machine while it runs; null when none does. */
export function machineSwitchInFlight(): Promise<void> | null {
  return switchInFlight;
}

/** Ends the hold in place, if any, without moving focus. A newer hold, a click or Esc ends it. */
export function releaseSwitchCursorHold(): void {
  releaseCurrent?.();
}

/** Keys the sidebar uses to move or open; any other key is the person going somewhere else. */
const SIDEBAR_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ', 'j', 'k']);

/** Where focus is kept even with no key press or click: a dialog or menu (the palette is one) or a text field. */
const KEEPS_FOCUS = [
  '[data-sidebar-item]',
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[role="menu"]', '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  'input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
].join(', ');

/**
 * Starts a hold for `options.switching`, replacing any hold already running. While it runs, the
 * person's own moves end it: a click, or a key that isn't the sidebar's. Every other move is the
 * switch's, and focus goes back to the cursor's row: when it was lost (to the body, or with a row
 * that re-rendered away), and when the restore, a re-render or the old tile's fallback focused a
 * button or page in the main area (review F-5). A dialog, menu or field keeps focus even then, so
 * the hold never takes input from where a dialog put it and never fights a focus trap (review F-1);
 * if anything else takes focus straight back, or takes it back a third time, the hold lets go
 * rather than take turns with it.
 */
export function holdCursorThroughSwitch(options: SwitchCursorHoldOptions): void {
  releaseCurrent?.();
  const pressedKey = keyOf(options.cursor());
  let lastKey = pressedKey;
  let released = false;
  let frame: number | null = null;

  const cursorRow = (): CursorRow | null => {
    const row = options.cursor();
    // A row that re-rendered away still names its key.
    lastKey = keyOf(row) ?? lastKey;
    if (row?.isConnected) return row;
    return lastKey ? options.findByKey(lastKey) : null;
  };
  const focusLost = (): boolean => {
    const active = document.activeElement;
    return !active || active === document.body || !active.isConnected;
  };
  // Losing focus with an element fires no focus event: check each frame.
  const watch = () => {
    frame = null;
    if (released) return;
    if (focusLost()) cursorRow()?.focus({ preventScroll: true });
    frame = requestAnimationFrame(watch);
  };
  let restoring = false;
  // Restores per element: one that takes focus back again and again (on a later frame, say)
  // would take turns with the hold, so after two the hold lets go (review F-8).
  const restores = new Map<Element, number>();
  // A focus move with no key or click from the person since the hold began is the switch's.
  // focusin fires once the new element is active.
  const onFocusIn = () => {
    if (released) return;
    const target = document.activeElement;
    if (!target || target === document.body || target.closest(KEEPS_FOCUS)) return;
    if (restoring) {
      // Something took focus back while the hold was restoring it: let it have focus.
      release();
      return;
    }
    const row = cursorRow();
    if (!row) return;
    const count = restores.get(target) ?? 0;
    if (count >= 2) {
      release();
      return;
    }
    restores.set(target, count + 1);
    restoring = true;
    try { row.focus({ preventScroll: true }); } finally { restoring = false; }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // mod+K is the palette, not the sidebar's k.
    if (!SIDEBAR_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) release();
  };
  const release = () => {
    if (released) return;
    released = true;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('mousedown', release, true);
    window.removeEventListener('focusin', onFocusIn, true);
    if (frame !== null) cancelAnimationFrame(frame);
    if (releaseCurrent === release) releaseCurrent = null;
  };

  // A click, or a key that isn't the sidebar's, is the person choosing where focus goes.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('mousedown', release, true);
  window.addEventListener('focusin', onFocusIn, true);
  frame = requestAnimationFrame(watch);
  releaseCurrent = release;

  void options.switching.catch(() => undefined).finally(() => {
    if (released) return;
    // Into the work only when focus is still on the pressed row, never over a dialog or a field.
    const onPressedRow = keyOf(cursorRow()) === pressedKey && document.activeElement?.getAttribute('data-sidebar-key') === pressedKey;
    release();
    if (onPressedRow) options.onLanded();
  });
}
