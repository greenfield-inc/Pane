import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';
import { useHotkeyStore } from './hotkeyStore';

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
    useHotkeyStore.getState().unregister('test-shortcut');
    useHotkeyStore.getState().unregister('open-command-palette');
    useConfigStore.setState({ config: null });
    vi.unstubAllGlobals();
  });

  it('does not execute or prevent disabled Pane shortcuts', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'test-shortcut',
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

  it('allows only the Search shortcut when configured as an exception', () => {
    const paletteAction = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'open-command-palette',
      label: 'Open Search',
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
      id: 'test-shortcut',
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
      id: 'test-shortcut',
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
});
