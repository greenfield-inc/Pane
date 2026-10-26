import { afterEach, expect, it, vi } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';
import { createFileLinkProvider } from './fileLinkProvider';

afterEach(() => vi.unstubAllGlobals());

it('opens a detected worktree file with a relative editor path and absolute reveal path', () => {
  vi.stubGlobal('navigator', { platform: 'Linux' });
  const onShowFilePopover = vi.fn();
  // SAFETY: The provider reads only this public terminal buffer surface.
  const terminal = { buffer: { active: { getLine: (index: number) => index === 0 ? { translateToString: () => './src/app.ts:42' } : undefined } } } as Terminal;
  const provider = createFileLinkProvider({
    terminal, workingDirectory: '/repo', onShowFilePopover,
    onShowTooltip: vi.fn(), onHideTooltip: vi.fn(), onOpenUrl: vi.fn(),
  });
  let links: ILink[] = [];
  provider.provideLinks(1, result => { links = result ?? []; });
  // SAFETY: Link activation only reads the modifier flag from the mouse event.
  links[0].activate({ ctrlKey: true } as MouseEvent, links[0].text);
  expect(onShowFilePopover.mock.calls[0].slice(1)).toEqual([
    { absolutePath: '/repo/src/app.ts', relativePath: 'src/app.ts' }, 42,
  ]);
});
