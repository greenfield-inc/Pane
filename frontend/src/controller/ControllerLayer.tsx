/**
 * Game controller support on desktop (docs/CONTROLLERS.md). Reads pads
 * through the Gamepad API (gamepadAdapter.ts), runs each scheme action
 * through the hotkey registry by its catalog id, so a keyboard key bound in
 * Settings › Shortcuts runs the same command, and draws the cheat sheet, the
 * key pad and the listening bar.
 */
import { useEffect, useRef, useState } from 'react';
import type { ControllerActionId, TerminalArrowActionId } from '../../../shared/controller/bindings';
import type { ControllerEvent } from '../../../shared/controller/interpreter';
import type { KeyboardShortcutId } from '../../../shared/constants/keyboardShortcuts';
import { useHotkey } from '../hooks/useHotkey';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { startGamepadAdapter, type GamepadAdapter } from './gamepadAdapter';
import {
  activateFocused,
  currentContext,
  goBack,
  isTerminalInput,
  moveControllerFocus,
  noteControllerFocusIn,
  openDialog,
  setControllerMode,
} from './controllerFocus';
import { expectSendConfirmation, focusedControllerTarget, setSendConfirmedListener, type TerminalKey } from './controllerTargets';
import { loadControllerPreferences, markCheatSheetSeen, useControllerStore } from './controllerStore';
import { openNextNeedsYou } from './nextNeedsYou';
import { focusedSurfaceScroll } from '../services/focusedSurfaceScroll';
import { ControllerCheatSheet } from './ControllerCheatSheet';
import { ControllerKeyPad } from './ControllerKeyPad';
import { useControllerDictation, ListeningBar } from './ControllerDictation';

const TERMINAL_ARROWS = {
  'terminal-arrow-up': 'up',
  'terminal-arrow-down': 'down',
  'terminal-arrow-left': 'left',
  'terminal-arrow-right': 'right',
} satisfies Record<TerminalArrowActionId, TerminalKey>;

function isTerminalArrow(action: ControllerActionId): action is TerminalArrowActionId {
  return action in TERMINAL_ARROWS;
}

/** A scroll repeat arrives every 60 ms while the right stick is pushed; a gap this long means it was let go. */
const SCROLL_RELEASE_MS = 150;

function runCommand(id: KeyboardShortcutId): void {
  const definition = useHotkeyStore.getState().hotkeys.get(id);
  if (!definition) return;
  if (definition.enabled && !definition.enabled()) return;
  if (openDialog() && !definition.allowInModal) return;
  definition.action();
}

function sendDraft(): void {
  // Inside an open approval, Send answers it (⌘↩).
  const approval = useHotkeyStore.getState().hotkeys.get('send-approval');
  if (approval?.enabled?.() && document.activeElement?.closest('[data-focus-region="approvals"], [aria-modal="true"]')) {
    approval.action();
    return;
  }
  const target = focusedControllerTarget();
  if (!target) return;
  expectSendConfirmation(target.panelId);
  target.send();
}

export function ControllerLayer() {
  const adapterRef = useRef<GamepadAdapter | null>(null);
  const scrollStop = useRef<number | null>(null);
  const swallowFrame = useRef(false);
  /** Unrecognised pads that have shown their note since they connected. */
  const explained = useRef(new Set<string>());
  const dictation = useControllerDictation();
  const dictationRef = useRef(dictation);
  useEffect(() => { dictationRef.current = dictation; });
  const keyPadOpen = useControllerStore(state => state.keyPadOpen);
  const [cheatSheetOpener, setCheatSheetOpener] = useState<HTMLElement | null>(null);

  useEffect(() => { void loadControllerPreferences(); }, []);

  useEffect(() => {
    const scroll = (direction: -1 | 1) => {
      focusedSurfaceScroll.start(direction);
      if (scrollStop.current !== null) window.clearTimeout(scrollStop.current);
      scrollStop.current = window.setTimeout(() => { scrollStop.current = null; focusedSurfaceScroll.stop(); }, SCROLL_RELEASE_MS);
    };

    const runAction = (action: ControllerActionId) => {
      if (isTerminalArrow(action)) {
        focusedControllerTarget()?.pressKey?.(TERMINAL_ARROWS[action]);
        return;
      }
      if (action === 'scroll-focused-surface-up' || action === 'scroll-focused-surface-down') {
        scroll(action === 'scroll-focused-surface-up' ? -1 : 1);
        return;
      }
      runCommand(action);
    };

    const onEvents = (events: ControllerEvent[]) => {
      const swallow = swallowFrame.current;
      swallowFrame.current = false;
      for (const event of events) {
        if (event.type === 'action') {
          if (!swallow) runAction(event.action);
        } else if (event.action === 'dictate-hold') {
          if (event.type === 'hold-start' && !swallow) dictationRef.current.start();
          if (event.type === 'hold-end') dictationRef.current.stop();
        } else if (event.type === 'hold-start') {
          if (!swallow) useControllerStore.setState({ cheatSheet: 'held' });
        } else if (useControllerStore.getState().cheatSheet === 'held') {
          useControllerStore.setState({ cheatSheet: 'closed' });
        }
      }
    };

    adapterRef.current = startGamepadAdapter({
      onDevice: (device, family) => useControllerStore.setState({ device, family }),
      onInput: (device, family) => {
        setControllerMode(true);
        const state = useControllerStore.getState();
        if (state.device?.id !== device.id || state.family !== family) useControllerStore.setState({ device, family });
        // The first press after install shows the cheat sheet once, and an unrecognised pad explains itself once per connection.
        const unexplained = family === 'unrecognised' && !explained.current.has(device.id);
        if ((state.preferencesLoaded && !state.cheatSheetSeen) || unexplained) {
          if (unexplained) explained.current.add(device.id);
          if (state.cheatSheet === 'closed') {
            setCheatSheetOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
            useControllerStore.setState({ cheatSheet: 'open' });
          }
          // The note isn't the sheet: a pad switched to a readable mode still gets the sheet once.
          if (family !== 'unrecognised') markCheatSheetSeen();
          swallowFrame.current = true;
        }
      },
      onEvents,
      onDisconnect: device => {
        explained.current.delete(device.id);
        if (useControllerStore.getState().device?.id === device.id) useControllerStore.setState({ device: null });
        setControllerMode(false);
      },
      context: () => currentContext(useControllerStore.getState().keyPadOpen),
      lettersOverride: () => useControllerStore.getState().buttonLetters,
    });
    setSendConfirmedListener(() => adapterRef.current?.rumble());

    // Touch, mouse or keyboard: the ring hides and everything works as before.
    const leaveControllerMode = (event: Event) => {
      if (event instanceof MouseEvent && event.type === 'mousemove' && event.movementX === 0 && event.movementY === 0) return;
      setControllerMode(false);
    };
    const pointerEvents = ['mousemove', 'pointerdown', 'wheel', 'keydown'] as const;
    for (const type of pointerEvents) window.addEventListener(type, leaveControllerMode, { capture: true, passive: true });
    const onFocusIn = (event: FocusEvent) => noteControllerFocusIn(event.target);
    window.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('focusin', onFocusIn, true);
      for (const type of pointerEvents) window.removeEventListener(type, leaveControllerMode, { capture: true });
      setSendConfirmedListener(null);
      adapterRef.current?.stop();
      adapterRef.current = null;
      if (scrollStop.current !== null) window.clearTimeout(scrollStop.current);
    };
  }, []);

  const buttonLetters = useControllerStore(state => state.buttonLetters);
  useEffect(() => { adapterRef.current?.refreshFamilies(); }, [buttonLetters]);

  // The scheme's commands, also bindable to keys in Settings › Shortcuts.
  useHotkey({ id: 'controller-focus-up', label: 'Move Focus Up', category: 'controller', allowInModal: true, action: () => moveControllerFocus('up') });
  useHotkey({ id: 'controller-focus-down', label: 'Move Focus Down', category: 'controller', allowInModal: true, action: () => moveControllerFocus('down') });
  useHotkey({ id: 'controller-focus-left', label: 'Move Focus Left', category: 'controller', allowInModal: true, action: () => moveControllerFocus('left') });
  useHotkey({ id: 'controller-focus-right', label: 'Move Focus Right', category: 'controller', allowInModal: true, action: () => moveControllerFocus('right') });
  useHotkey({
    id: 'controller-activate',
    label: 'Open or Pick Focused Item',
    category: 'controller',
    allowInModal: true,
    action: () => {
      if (isTerminalInput(document.activeElement)) focusedControllerTarget()?.pressKey?.('enter');
      else activateFocused();
    },
  });
  useHotkey({ id: 'controller-back', label: 'Back', category: 'controller', allowInModal: true, action: goBack });
  useHotkey({ id: 'controller-switch-column', label: 'Switch Split Column', category: 'controller', action: switchColumn });
  useHotkey({ id: 'dictate-hold', label: 'Dictate (start or stop)', category: 'controller', allowInModal: true, action: () => dictationRef.current.toggle() });
  useHotkey({ id: 'send-draft', label: 'Send Draft', category: 'controller', allowInModal: true, action: sendDraft });
  useHotkey({
    id: 'open-key-pad',
    label: 'Open Key Pad',
    category: 'controller',
    allowInModal: true,
    enabled: () => useControllerStore.getState().keyPadOpen || focusedControllerTarget()?.kind === 'terminal',
    action: () => useControllerStore.setState(state => ({ keyPadOpen: !state.keyPadOpen })),
  });
  useHotkey({ id: 'jump-to-bottom', label: 'Jump to Bottom', category: 'controller', action: () => focusedControllerTarget()?.jumpToBottom() });
  useHotkey({ id: 'next-needs-you', label: 'Next Thing That Needs You', category: 'controller', action: () => { openNextNeedsYou(); } });
  // Search opens on its Recent section when the query is empty.
  useHotkey({ id: 'open-recent', label: 'Open Recent', category: 'controller', action: () => runCommand('open-command-palette') });
  useHotkey({
    id: 'show-controller-help',
    label: 'Show Controller Buttons',
    category: 'controller',
    allowInModal: true,
    action: () => {
      const open = useControllerStore.getState().cheatSheet !== 'closed';
      if (!open) setCheatSheetOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      useControllerStore.setState({ cheatSheet: open ? 'closed' : 'open' });
    },
  });

  return (
    <>
      <ControllerCheatSheet opener={cheatSheetOpener} />
      {keyPadOpen && <ControllerKeyPad />}
      <ListeningBar dictation={dictation} />
    </>
  );
}

/** L1+R1: focus moves to the next split tab group in the main area, with no tab change. */
function switchColumn(): void {
  const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-region="main"] [data-panel-group-id]'))
    .filter(group => group.getBoundingClientRect().width > 0);
  if (groups.length < 2) return;
  const current = groups.findIndex(group => group.contains(document.activeElement));
  const next = groups[(current + 1) % groups.length];
  const input = next.querySelector<HTMLElement>('.xterm-helper-textarea, textarea[data-chat-composer], [role="tab"][aria-selected="true"]');
  (input ?? next).focus({ preventScroll: true });
}
