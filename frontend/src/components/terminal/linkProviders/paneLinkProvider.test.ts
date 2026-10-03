import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { createPaneLinkProvider } from './paneLinkProvider';

const url = 'pane://open?pane=fd3f9b5a-17ef-4385-917e-e5e8039fb547&panel=5d7f9f91-8301-4ba9-842c-7dcad54c92f1';

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise(resolve => terminal.write(text, resolve));
}

describe('Pane terminal link provider', () => {
  it('opens the full link on a plain click', async () => {
    const terminal = new Terminal({ cols: 200 });
    await write(terminal, `Open: ${url} (Pane)`);
    const onOpenPane = vi.fn();
    const provider = createPaneLinkProvider({
      terminal,
      workingDirectory: '/',
      onOpenPane,
      onOpenUrl: vi.fn(),
      onShowTooltip: vi.fn(),
      onHideTooltip: vi.fn(),
      onShowFilePopover: vi.fn(),
    });
    provider.provideLinks(1, links => {
      expect(links).toHaveLength(1);
      expect(links?.[0].text).toBe(url);
      // SAFETY: This provider's activate callback does not read the event.
      links?.[0].activate({} as MouseEvent, url);
      expect(onOpenPane).toHaveBeenCalledWith(url);
    });
    terminal.dispose();
  });

  it('recognizes a URL across wrapped terminal rows', async () => {
    const terminal = new Terminal({ cols: 48, rows: 5 });
    await write(terminal, `Open: ${url}`);
    const provider = createPaneLinkProvider({
      terminal,
      workingDirectory: '/',
      onOpenPane: vi.fn(),
      onOpenUrl: vi.fn(),
      onShowTooltip: vi.fn(),
      onHideTooltip: vi.fn(),
      onShowFilePopover: vi.fn(),
    });
    provider.provideLinks(2, links => {
      expect(links?.[0].text).toBe(url);
      expect(links?.[0].range.start).toEqual({ x: 7, y: 1 });
      expect(links?.[0].range.end.y).toBe(3);
    });
    terminal.dispose();
  });
});
