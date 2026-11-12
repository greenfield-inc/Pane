import type { MenuItemConstructorOptions, PopupOptions, WebContents } from 'electron';
import { Menu } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showContextMenu } from './nativeMenus';

/** The menu showContextMenu built and how it popped it up. */
interface ShownMenu {
  template: MenuItemConstructorOptions[];
  popup?: PopupOptions;
}

function captureMenu(): ShownMenu {
  const shown: ShownMenu = { template: [] };
  vi.mocked(Menu.buildFromTemplate).mockImplementationOnce((template) => {
    // SAFETY: showContextMenu passes only constructor options, never built MenuItems.
    shown.template = template as MenuItemConstructorOptions[];
    // SAFETY: showContextMenu reads only popup from the built menu.
    return { popup: (options?: PopupOptions) => { shown.popup = options; } } as Electron.Menu;
  });
  return shown;
}

function click(item: MenuItemConstructorOptions | undefined) {
  // SAFETY: The handlers under test ignore click's arguments.
  item?.click?.(undefined as never, undefined, undefined as never);
}

describe('showContextMenu', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the listed items and resolves with the chosen id', async () => {
    const shown = captureMenu();
    // SAFETY: Choosing an item calls no WebContents method.
    const contents = {} as WebContents;

    const choice = showContextMenu(contents, [
      { type: 'item', id: 'copy', label: 'Copy', enabled: false, accelerator: 'Cmd+C' },
      { type: 'separator' },
      { type: 'item', id: 'open-url', label: 'Open URL', enabled: true },
    ]);

    expect(shown.template).toEqual([
      expect.objectContaining({ label: 'Copy', enabled: false, accelerator: 'Cmd+C', registerAccelerator: false }),
      { type: 'separator' },
      expect.objectContaining({ label: 'Open URL', enabled: true }),
    ]);
    click(shown.template[2]);
    await expect(choice).resolves.toBe('open-url');
  });

  it('performs Paste natively, so the focused element gets a paste event', async () => {
    const shown = captureMenu();
    const paste = vi.fn();
    // SAFETY: Paste is the only WebContents member the menu uses.
    const contents = { paste } as WebContents;

    const choice = showContextMenu(contents, [{ type: 'paste', id: 'paste', label: 'Paste', enabled: true }]);
    click(shown.template[0]);

    await expect(choice).resolves.toBe('paste');
    expect(paste).toHaveBeenCalledOnce();
  });

  it('resolves with null when the menu closes without a choice', async () => {
    vi.useFakeTimers();
    const shown = captureMenu();
    // SAFETY: Dismissing the menu calls no WebContents method.
    const choice = showContextMenu({} as WebContents, [{ type: 'item', id: 'copy', label: 'Copy', enabled: true }]);

    shown.popup?.callback?.();
    await vi.runAllTimersAsync();

    await expect(choice).resolves.toBeNull();
  });

  it('keeps a choice whose click arrives just after the close callback', async () => {
    vi.useFakeTimers();
    const shown = captureMenu();
    // SAFETY: Choosing an item calls no WebContents method.
    const choice = showContextMenu({} as WebContents, [{ type: 'item', id: 'copy', label: 'Copy', enabled: true }]);

    shown.popup?.callback?.();
    click(shown.template[0]);
    await vi.runAllTimersAsync();

    await expect(choice).resolves.toBe('copy');
  });
});
