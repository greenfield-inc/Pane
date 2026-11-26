/**
 * The tabs a controller writes into: a chat tab's composer and a terminal
 * agent's input line. Each mounted panel registers what dictation (R2), Send
 * (Y), the key pad (X) and jump to bottom (R3) do for it, on its root element.
 * The target is the one holding focus, else the focused split's.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export interface ControllerTarget {
  panelId: string;
  kind: 'chat' | 'terminal';
  /** Dictated words: into the chat composer, or typed into the agent's input as a paste with no Enter. */
  insertText(text: string): void;
  /** Y: the chat's Send, or Enter on its own in a terminal. */
  send(): void;
  jumpToBottom(): void;
  /** The D-pad, A and the key pad's keys; terminals only. */
  pressKey?(key: TerminalKey): void;
}

export type TerminalKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'ctrl-c' | 'tab' | 'shift-tab';

/** The bytes a key sends, in the terminal's cursor-key mode (DECCKM) as a keyboard would. */
export function terminalKeyBytes(key: TerminalKey, applicationCursorKeys: boolean): string {
  const arrow = applicationCursorKeys ? '\x1bO' : '\x1b[';
  switch (key) {
    case 'up': return `${arrow}A`;
    case 'down': return `${arrow}B`;
    case 'right': return `${arrow}C`;
    case 'left': return `${arrow}D`;
    case 'enter': return '\r';
    case 'escape': return '\x1b';
    case 'ctrl-c': return '\x03';
    case 'tab': return '\t';
    case 'shift-tab': return '\x1b[Z';
  }
}

const targets = new Map<Element, ControllerTarget>();

function registerControllerTarget(element: Element, target: ControllerTarget): () => void {
  targets.set(element, target);
  return () => {
    if (targets.get(element) === target) targets.delete(element);
  };
}

/** Registers `target` on `ref`'s element while mounted; the latest functions are always used. */
export function useControllerTarget(ref: RefObject<Element | null>, target: ControllerTarget): void {
  const latest = useRef(target);
  useLayoutEffect(() => { latest.current = target; });
  const { panelId, kind } = target;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return registerControllerTarget(element, {
      panelId,
      kind,
      insertText: text => latest.current.insertText(text),
      send: () => latest.current.send(),
      jumpToBottom: () => latest.current.jumpToBottom(),
      pressKey: key => latest.current.pressKey?.(key),
    });
  }, [ref, panelId, kind]);
}

function isShown(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The target focus is in, else the one in the focused split of the main area. */
export function focusedControllerTarget(): ControllerTarget | null {
  const active = document.activeElement;
  for (const [element, target] of targets) {
    if (active && element.contains(active)) return target;
  }
  const group = document.querySelector('[data-focus-region="main"] [data-panel-group-id][data-group-focused="true"]')
    ?? document.querySelector('[data-focus-region="main"]');
  if (!group) return null;
  for (const [element, target] of targets) {
    if (group.contains(element) && isShown(element)) return target;
  }
  return null;
}

// --- Rumble when the host confirms a controller send ---

const CONFIRM_WINDOW_MS = 30_000;
const awaitingConfirm = new Map<string, number>();
let onConfirmed: (() => void) | null = null;

export function setSendConfirmedListener(listener: (() => void) | null): void {
  onConfirmed = listener;
}

/** A controller press sent this panel's draft; its confirmation should pulse the pad. */
export function expectSendConfirmation(panelId: string): void {
  awaitingConfirm.set(panelId, Date.now());
}

/** The host took a message from this panel (ChatTabPanel's settle, or a terminal's Enter). */
export function noteSendConfirmed(panelId: string): void {
  const since = awaitingConfirm.get(panelId);
  awaitingConfirm.delete(panelId);
  if (since !== undefined && Date.now() - since < CONFIRM_WINDOW_MS) onConfirmed?.();
}
