/**
 * Keeps keyboard focus on the sidebar's cursor while a switch to another machine runs (T-128, D-6).
 *
 * Enter on a row usually moves focus into the work it opens. On another machine the work isn't
 * there until the switch lands, and the switch re-renders the sidebar and the main area meanwhile:
 * focus fell to a main-area button, then to the page body, and arrow keys stopped moving the
 * cursor (#1767's rig: 39 of 40 presses lost). The hold puts focus back on the cursor's row (found
 * again by its key when the row re-rendered) every time something else takes it, so the person can
 * keep arrowing. When the switch ends with the cursor still on the pressed row, focus moves into
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

/**
 * Starts a hold for `options.switching`, replacing any hold already running. Focus goes back to the
 * cursor's row only when it was lost: to the body, or with a row that re-rendered away. Anywhere
 * else focus goes (a dialog, the palette, the composer) is left alone, so the hold never takes
 * input from where the person or a dialog put it, and never fights a focus trap (review F-1).
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
  const onKeyDown = (event: KeyboardEvent) => {
    if (!SIDEBAR_KEYS.has(event.key)) release();
  };
  const release = () => {
    if (released) return;
    released = true;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('mousedown', release, true);
    if (frame !== null) cancelAnimationFrame(frame);
    if (releaseCurrent === release) releaseCurrent = null;
  };

  // A click, or a key that isn't the sidebar's, is the person choosing where focus goes.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('mousedown', release, true);
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
