import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';
import {
  isBoundChordForEvent,
  isTuiReleasableChordForEvent,
  useHotkeyStore,
} from './hotkeyStore';

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

  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: HotkeyTestEvent) => void) => {
        if (type === 'keydown') keydownListener = listener;
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
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
      config: { keyboardShortcutOverrides: { 'open-settings': 'mod+alt+7' } },
    });
    useHotkeyStore.getState().register({
      id: 'open-settings', label: 'Open Settings', category: 'navigation', action,
    });
    const oldEvent = keyboardEvent({ key: ',', code: 'Comma', ctrlKey: true }, target, vi.fn());
    const newEvent = keyboardEvent({ key: '7', code: 'Digit7', ctrlKey: true, altKey: true }, target, vi.fn());
    keydownListener?.(oldEvent);
    keydownListener?.(newEvent);
    expect(action).toHaveBeenCalledOnce();
    expect(useHotkeyStore.getState().hotkeys.get('open-settings')?.keys).toBe('mod+alt+7');

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
    ['mod+shift+z', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }, true, true],
    ['mod+\\', { key: '\\', code: 'Backslash', ctrlKey: true }, true, true],
    ['mod+alt+ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }, true, true],
    ['mod+alt+/', { key: '/', code: 'Slash', ctrlKey: true, altKey: true }, false, true],
    ['mod+alt+3', { key: '3', code: 'Digit3', ctrlKey: true, altKey: true }, true, true],
    ['mod+`', { key: '`', code: 'Backquote', ctrlKey: true }, false, true],
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
});
