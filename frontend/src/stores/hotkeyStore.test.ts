import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';
import {
  cancelKeySequence,
  isBoundChordForEvent,
  isTuiReleasableChordForEvent,
  KEY_SEQUENCE_TIMEOUT_MS,
  useHotkeyStore,
  useKeySequenceStore,
} from './hotkeyStore';

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock('../utils/platformUtils', () => ({ isMac: () => platform.mac, isWindows: () => false }));

interface HotkeyTestTarget {
  tagName: string;
  isContentEditable: boolean;
  classList?: { contains: (name: string) => boolean };
  closest: (selector: string) => { matched: true } | null;
}

interface HotkeyTestEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: HotkeyTestTarget;
  getModifierState: (keyArg: string) => boolean;
  preventDefault: () => void;
}

function keyboardEvent(
  init: KeyboardEventInit,
  target: HotkeyTestTarget,
  preventDefault: () => void,
): HotkeyTestEvent {
  return {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target,
    getModifierState: () => false,
    preventDefault,
  };
}

describe('hotkeyStore keyboard shortcut preference', () => {
  let keydownListener: ((event: HotkeyTestEvent) => void) | undefined;
  let captureListener: ((event: HotkeyTestEvent) => void) | undefined;

  beforeEach(() => {
    platform.mac = false;
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: HotkeyTestEvent) => void, capture?: boolean) => {
        if (type === 'keydown' && capture) captureListener = listener;
        else if (type === 'keydown') keydownListener = listener;
      },
      removeEventListener: vi.fn(),
    });
  });

  /** A press as the window sees it: capture listeners first, then bubble. */
  function press(event: HotkeyTestEvent): void {
    let stopped = false;
    const withStop = { ...event, stopPropagation: () => { stopped = true; } };
    captureListener?.(withStop);
    if (!stopped) keydownListener?.(withStop);
  }

  afterEach(() => {
    cancelKeySequence();
    vi.useRealTimers();
    for (const id of useHotkeyStore.getState().hotkeys.keys()) {
      useHotkeyStore.getState().unregister(id);
    }
    useConfigStore.setState({ config: null });
    vi.unstubAllGlobals();
  });

  it('does not execute or prevent disabled Pane shortcuts', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'terminal-shortcut-test',
      label: 'Test shortcut',
      keys: 'mod+w',
      category: 'tabs',
      action,
    });

    keydownListener?.(keyboardEvent({
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, { tagName: 'DIV', isContentEditable: false, closest: () => null }, preventDefault));

    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('waits for config while preserving legacy enabled behavior', () => {
    expect(areKeyboardShortcutsEnabled(null)).toBe(false);
    expect(areKeyboardShortcutsEnabled({})).toBe(true);
    expect(isCommandPaletteShortcutEnabled(null)).toBe(false);
    expect(isCommandPaletteShortcutEnabled({ keyboardShortcutsEnabled: false })).toBe(true);
  });

  it('allows only the Command Palette shortcut when configured as an exception', () => {
    const paletteAction = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'open-command-palette',
      label: 'Open Command Palette',
      keys: 'mod+shift+p',
      category: 'navigation',
      action: paletteAction,
    });

    keydownListener?.(keyboardEvent({
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, { tagName: 'DIV', isContentEditable: false, closest: () => null }, preventDefault));

    expect(paletteAction).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();

    useConfigStore.setState({
      config: {
        keyboardShortcutsEnabled: false,
        commandPaletteShortcutEnabled: false,
      },
    });
    keydownListener?.(keyboardEvent({
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, { tagName: 'DIV', isContentEditable: false, closest: () => null }, preventDefault));

    expect(paletteAction).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('allows an opted-in unmodified shortcut from xterm but not ordinary textareas', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: {} });
    useHotkeyStore.getState().register({
      id: 'terminal-shortcut-test',
      label: 'Scroll terminal',
      keys: 'shift+ArrowDown',
      category: 'view',
      action,
      allowInXterm: true,
    });
    const event = {
      key: 'ArrowDown',
      code: 'ArrowDown',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      getModifierState: () => false,
      preventDefault,
    };

    keydownListener?.(keyboardEvent({
      ...event,
    }, {
        tagName: 'TEXTAREA',
        isContentEditable: false,
        classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
        closest: () => null,
      }, preventDefault));
    keydownListener?.(keyboardEvent({
      ...event,
    }, {
        tagName: 'TEXTAREA',
        isContentEditable: false,
        classList: { contains: () => false },
        closest: () => null,
      }, preventDefault));

    expect(action).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('runs only explicitly modal-safe shortcuts inside dialogs', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: {} });
    const definition = {
      id: 'terminal-shortcut-test' as const,
      label: 'Scroll modal',
      keys: 'shift+ArrowUp',
      category: 'view' as const,
      action,
    };
    const dispatch = () => keydownListener?.(keyboardEvent({
      key: 'ArrowUp',
      code: 'ArrowUp',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, {
        tagName: 'DIV',
        isContentEditable: false,
        closest: (selector: string) => selector === '[aria-modal="true"]' ? { matched: true } : null,
      }, preventDefault));

    useHotkeyStore.getState().register(definition);
    dispatch();
    useHotkeyStore.getState().register({ ...definition, allowInModal: true });
    dispatch();

    expect(action).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('remaps dispatch immediately and unassigns without removing the command', () => {
    const action = vi.fn();
    const target = { tagName: 'DIV', isContentEditable: false, closest: () => null };
    useConfigStore.setState({
      config: { keyboardShortcutOverrides: { 'open-settings': 'mod+alt+j' } },
    });
    useHotkeyStore.getState().register({
      id: 'open-settings', label: 'Open Settings', category: 'navigation', action,
    });
    const oldEvent = keyboardEvent({ key: ',', code: 'Comma', ctrlKey: true }, target, vi.fn());
    const newEvent = keyboardEvent({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true }, target, vi.fn());
    keydownListener?.(oldEvent);
    keydownListener?.(newEvent);
    expect(action).toHaveBeenCalledOnce();
    expect(useHotkeyStore.getState().hotkeys.get('open-settings')?.keys).toBe('mod+alt+j');

    useConfigStore.setState({
      config: { keyboardShortcutOverrides: { 'open-settings': null } },
    });
    keydownListener?.(newEvent);
    expect(action).toHaveBeenCalledOnce();
    expect(useHotkeyStore.getState().hotkeys.get('open-settings')?.keys).toBe('');
  });

  it('runs neither command when enabled candidates share a chord', () => {
    const first = vi.fn();
    const second = vi.fn();
    const preventDefault = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useConfigStore.setState({ config: { keyboardShortcutOverrides: {
      'open-settings': 'mod+x', 'new-session': 'mod+x',
    } } });
    useHotkeyStore.getState().register({ id: 'open-settings', label: 'Settings', category: 'navigation', action: first });
    useHotkeyStore.getState().register({ id: 'new-session', label: 'New Pane', category: 'session', action: second });
    keydownListener?.(keyboardEvent(
      { key: 'x', code: 'KeyX', ctrlKey: true },
      { tagName: 'DIV', isContentEditable: false, closest: () => null },
      preventDefault,
    ));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[hotkeyStore] Ambiguous chord', 'mod+x', ['open-settings', 'new-session']);
  });

  it('keeps terminal interception mount-independent and follows remaps', () => {
    useConfigStore.setState({ config: { keyboardShortcutOverrides: {
      'add-tool-terminal-claude': 'mod+alt+j', 'git-push': 'mod+alt+g',
    } } });
    const event = (keyName: string, code: string) => keyboardEvent(
      { key: keyName, code, ctrlKey: true, altKey: true },
      { tagName: 'DIV', isContentEditable: false, closest: () => null },
      vi.fn(),
    );
    expect(isBoundChordForEvent(event('7', 'Digit7'))).toBe(true);
    expect(isBoundChordForEvent(event('5', 'Digit5'))).toBe(true);
    expect(isTuiReleasableChordForEvent(event('j', 'KeyJ'))).toBe(true);
    expect(isTuiReleasableChordForEvent(event('g', 'KeyG'))).toBe(false);
    expect(isBoundChordForEvent(event('y', 'KeyY'))).toBe(false);
  });

  it.each([
    ['mod+shift+Tab', { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }, true, true],
    ['mod+Tab', { key: 'Tab', code: 'Tab', ctrlKey: true }, true, true],
    ['mod+shift+3', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true }, true, true],
    ['mod+shift+z (no longer bound: Redo)', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }, false, false],
    ['mod+\\', { key: '\\', code: 'Backslash', ctrlKey: true }, true, true],
    ['mod+alt+ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }, true, true],
    ['mod+alt+/ (moved to two-step)', { key: '/', code: 'Slash', ctrlKey: true, altKey: true }, false, false],
    ['mod+alt+3', { key: '3', code: 'Digit3', ctrlKey: true, altKey: true }, true, true],
    ['mod+`', { key: '`', code: 'Backquote', ctrlKey: true }, true, true],
    ['mod+0', { key: '0', code: 'Digit0', ctrlKey: true }, true, true],
    ['F6', { key: 'F6', code: 'F6' }, true, true],
    ['mod+PageDown', { key: 'PageDown', code: 'PageDown', ctrlKey: true }, true, true],
    ['mod+shift+u', { key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true }, false, true],
    ['mod+shift+s', { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }, false, false],
  ] satisfies readonly [string, KeyboardEventInit, boolean, boolean][])(
    'joins the %s event to catalog interception sets',
    (_chord, init, expectedTuiReleasable, expectedBound) => {
      useConfigStore.setState({ config: {} });
      const event = keyboardEvent(
        init,
        { tagName: 'DIV', isContentEditable: false, closest: () => null },
        vi.fn(),
      );

      expect(isTuiReleasableChordForEvent(event)).toBe(expectedTuiReleasable);
      expect(isBoundChordForEvent(event)).toBe(expectedBound);
    },
  );

  it('keeps the palette exception attached to its remapped id', () => {
    const action = vi.fn();
    useConfigStore.setState({ config: {
      keyboardShortcutsEnabled: false,
      keyboardShortcutOverrides: { 'open-command-palette': 'mod+alt+p' },
    } });
    useHotkeyStore.getState().register({
      id: 'open-command-palette', label: 'Palette', category: 'navigation', action,
    });
    keydownListener?.(keyboardEvent(
      { key: 'p', code: 'KeyP', ctrlKey: true, altKey: true },
      { tagName: 'DIV', isContentEditable: false, closest: () => null },
      vi.fn(),
    ));
    expect(action).toHaveBeenCalledOnce();
  });

  const div = { tagName: 'DIV', isContentEditable: false, closest: () => null };
  const textarea = { tagName: 'TEXTAREA', isContentEditable: false, classList: { contains: () => false }, closest: () => null };

  it('runs a two-step key and shows the waiting state between steps', () => {
    const action = vi.fn();
    useConfigStore.setState({ config: {} });
    useHotkeyStore.getState().register({ id: 'zoom-toggle', label: 'Maximize', category: 'view', action });
    const first = vi.fn();
    press(keyboardEvent({ key: 'k', code: 'KeyK', ctrlKey: true }, div, first));
    expect(first).toHaveBeenCalled();
    expect(useKeySequenceStore.getState().pending?.first).toBe('mod+k');
    press(keyboardEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true }, div, vi.fn()));
    expect(useKeySequenceStore.getState().pending).not.toBeNull();
    press(keyboardEvent({ key: 'm', code: 'KeyM', ctrlKey: true }, div, vi.fn()));
    expect(action).toHaveBeenCalledOnce();
    expect(useKeySequenceStore.getState().pending).toBeNull();
  });

  it('cancels a two-step key quietly on an unknown second key or a timeout', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const other = vi.fn();
    useConfigStore.setState({ config: {} });
    useHotkeyStore.getState().register({ id: 'zoom-toggle', label: 'Maximize', category: 'view', action });
    useHotkeyStore.getState().register({ id: 'new-session', label: 'New Pane', category: 'session', action: other });
    press(keyboardEvent({ key: 'k', code: 'KeyK', ctrlKey: true }, div, vi.fn()));
    const unknown = vi.fn();
    press(keyboardEvent({ key: 'x', code: 'KeyX', ctrlKey: true }, div, unknown));
    expect(unknown).not.toHaveBeenCalled();
    expect(useKeySequenceStore.getState().pending).toBeNull();

    press(keyboardEvent({ key: 'k', code: 'KeyK', ctrlKey: true }, div, vi.fn()));
    vi.advanceTimersByTime(KEY_SEQUENCE_TIMEOUT_MS + 1);
    expect(useKeySequenceStore.getState().pending).toBeNull();
    press(keyboardEvent({ key: 'm', code: 'KeyM', ctrlKey: true }, div, vi.fn()));
    expect(action).not.toHaveBeenCalled();
  });

  it('starts a two-step key from a text field, since its first step holds Ctrl/Cmd', () => {
    const action = vi.fn();
    useConfigStore.setState({ config: {} });
    useHotkeyStore.getState().register({ id: 'open-shortcut-settings', label: 'Shortcuts', category: 'shortcuts', action });
    press(keyboardEvent({ key: 'k', code: 'KeyK', ctrlKey: true }, textarea, vi.fn()));
    press(keyboardEvent({ key: 's', code: 'KeyS', ctrlKey: true }, textarea, vi.fn()));
    expect(action).toHaveBeenCalledOnce();
  });

  it('leaves Select All and Redo to a text field even when they are bound', () => {
    const action = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutOverrides: { 'cycle-tab-prev-a': 'mod+a', 'zoom-toggle': 'mod+shift+z' } } });
    useHotkeyStore.getState().register({ id: 'cycle-tab-prev-a', label: 'Prev', category: 'tabs', action });
    useHotkeyStore.getState().register({ id: 'zoom-toggle', label: 'Max', category: 'view', action });
    const preventDefault = vi.fn();
    press(keyboardEvent({ key: 'a', code: 'KeyA', ctrlKey: true }, textarea, preventDefault));
    press(keyboardEvent({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }, textarea, preventDefault));
    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    press(keyboardEvent({ key: 'a', code: 'KeyA', ctrlKey: true }, div, vi.fn()));
    expect(action).toHaveBeenCalledOnce();
  });

  it('lets F6 reach Pane from a text field but keeps plain arrows in it', () => {
    const action = vi.fn();
    useConfigStore.setState({ config: {} });
    useHotkeyStore.getState().register({ id: 'focus-next-region', label: 'Next region', category: 'navigation', action });
    press(keyboardEvent({ key: 'F6', code: 'F6' }, textarea, vi.fn()));
    expect(action).toHaveBeenCalledOnce();
  });

  it('on macOS, Command bindings never match Control', () => {
    platform.mac = true;
    const action = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutOverrides: {} } });
    useHotkeyStore.getState().register({ id: 'toggle-sidebar', label: 'Sidebar', category: 'view', action });
    press(keyboardEvent({ key: 'b', code: 'KeyB', ctrlKey: true }, div, vi.fn()));
    expect(action).not.toHaveBeenCalled();
    expect(isBoundChordForEvent(keyboardEvent({ key: 'b', code: 'KeyB', ctrlKey: true }, div, vi.fn()))).toBe(false);
    press(keyboardEvent({ key: 'b', code: 'KeyB', metaKey: true }, div, vi.fn()));
    expect(action).toHaveBeenCalledOnce();
  });
});
