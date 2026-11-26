/**
 * The controller's focus ring on desktop: real DOM focus, moved by direction
 * with the shared geometry (shared/controller/geometry.ts). Inside a dialog
 * focus stays in the dialog; elsewhere it moves within the focused region
 * (`data-focus-region`) and crosses to the next region at an edge, the same
 * way ⌘⌥+arrows do (regionFocus.ts).
 *
 * `:focus-visible` doesn't follow gamepad input, so while the controller is in
 * use the root carries `data-controller-mode` and index.css draws the ring.
 */
import type { ControllerContext } from '../../../shared/controller/bindings';
import { pickInDirection, type Rect } from '../../../shared/controller/geometry';
import type { Direction } from '../../../shared/controller/types';
import { focusSidebar, moveFocus } from '../services/regionFocus';

const FOCUSABLE = [
  'button:not([disabled])', 'a[href]', 'input:not([disabled]):not([type="hidden"])', 'textarea:not([disabled])',
  'select:not([disabled])', '[role="button"]', '[role="tab"]', '[role="option"]', '[role="menuitem"]',
  '[role="radio"]', '[role="checkbox"]', '[data-sidebar-item]', '[tabindex]:not([tabindex="-1"])',
].join(', ');

const XTERM_INPUT = 'xterm-helper-textarea';

export function isTerminalInput(element: Element | null): boolean {
  return Boolean(element?.classList.contains(XTERM_INPUT));
}

function rectOf(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function isShown(element: HTMLElement): boolean {
  if (element.closest('[inert], [aria-hidden="true"]')) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** The topmost open dialog, which keeps focus while it is open. */
export function openDialog(): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter(dialog => dialog.isConnected);
  return dialogs.at(-1) ?? null;
}

/**
 * The element that stands for `element` as a focus target: a terminal is one
 * target (its xterm box), focused through xterm's own input.
 */
function targetFor(element: HTMLElement): HTMLElement {
  return isTerminalInput(element) ? element.closest<HTMLElement>('.xterm') ?? element : element;
}

function focusTarget(target: HTMLElement): void {
  const input = target.classList.contains('xterm') ? target.querySelector<HTMLElement>(`.${XTERM_INPUT}`) : null;
  (input ?? target).focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function candidatesIn(scope: ParentNode): HTMLElement[] {
  const found = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isShown);
  const terminals = Array.from(scope.querySelectorAll<HTMLElement>('.xterm')).filter(isShown);
  // Controls nested in another candidate (a button inside a sidebar row) stay reachable; a terminal is one stop.
  return [...found.filter(element => !element.closest('.xterm')), ...terminals];
}

/** The region focus is in now, or the main area when nothing has focus. */
function currentScope(active: HTMLElement | null): ParentNode {
  const dialog = openDialog();
  if (dialog) return dialog;
  return active?.closest('[data-focus-region]') ?? document.querySelector('[data-focus-region="main"]') ?? document;
}

function activeElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/** Moves focus to the nearest control in `direction`, crossing into the next region at an edge. */
export function moveControllerFocus(direction: Direction): void {
  const active = activeElement();
  const scope = currentScope(active);
  const candidates = candidatesIn(scope);
  if (!active || !(scope instanceof Node && scope.contains(active))) {
    const first = candidates[0];
    if (first) focusTarget(first);
    return;
  }
  const from = targetFor(active);
  const picked = pickInDirection(rectOf(from), candidates.filter(element => element !== from).map(element => ({ id: element, rect: rectOf(element) })), direction);
  if (picked) {
    focusTarget(picked);
    return;
  }
  if (openDialog()) return;
  // At the region's edge: the next region that way, as ⌘⌥+arrows go.
  if (moveFocus(direction)) return;
  if (direction === 'left') focusSidebar();
}

/** A question or approval ignores A this long after focus enters it, so the press that opened it can't answer it. */
const ANSWER_GUARD_MS = 250;
/** Approvals and a Session's approval column: where one press answers a question. */
const ANSWER_SURFACE = '[data-focus-region="approvals"]';
let answerSurface: Element | null = null;
let answerSurfaceSince = 0;

/** Called on every focusin: remembers when focus entered a question or approval. */
export function noteControllerFocusIn(target: EventTarget | null): void {
  const surface = target instanceof Element ? target.closest(ANSWER_SURFACE) : null;
  if (surface === answerSurface) return;
  answerSurface = surface;
  answerSurfaceSince = performance.now();
}

/** True just after focus entered a question or approval: A and Y wait out ANSWER_GUARD_MS there. */
export function answerGuardActive(): boolean {
  const active = activeElement();
  return Boolean(active && answerSurface?.contains(active) && performance.now() - answerSurfaceSince < ANSWER_GUARD_MS);
}

/** A: what a click on the focused control does. */
export function activateFocused(): boolean {
  const active = activeElement();
  if (!active || isTerminalInput(active)) return false;
  if (answerGuardActive()) return false;
  if (active instanceof HTMLInputElement && (active.type === 'text' || active.type === 'search')) return false;
  if (active instanceof HTMLTextAreaElement) return false;
  active.click();
  return true;
}

/** B: close the open dialog (as Esc does), or go back to the sidebar. */
export function goBack(): void {
  const dialog = openDialog();
  if (dialog) {
    const target = activeElement() ?? dialog;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return;
  }
  focusSidebar();
}

export function currentContext(keyPadOpen: boolean): ControllerContext {
  if (keyPadOpen) return 'keypad';
  if (document.activeElement?.matches('[role="combobox"][aria-label="Search"]')) return 'search';
  if (openDialog()) return 'sheet';
  if (isTerminalInput(activeElement())) return 'terminal';
  return activeElement()?.closest('[data-focus-region="sidebar"]') ? 'home' : 'tab';
}

/** Shows the ring until the person touches the mouse or keyboard again. */
export function setControllerMode(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute('data-controller-mode', 'true');
  else root.removeAttribute('data-controller-mode');
}
