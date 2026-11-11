import { afterEach, expect, it, vi } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';
import { createCustomLinkProvider } from './customLinkProvider';

afterEach(() => vi.unstubAllGlobals());

it('links a matching issue key and opens it on Ctrl+Click only', () => {
  vi.stubGlobal('navigator', { platform: 'Linux' });
  const onOpenUrl = vi.fn();
  const onShowTooltip = vi.fn();
  // SAFETY: The provider reads only this public terminal buffer surface.
  const terminal = { buffer: { active: { getLine: (index: number) => index === 0 ? { translateToString: () => 'see PROJ-42' } : undefined } } } as Terminal;
  const provider = createCustomLinkProvider({
    terminal, workingDirectory: '/repo', onOpenUrl, onShowTooltip,
    customLinks: [{
      enabled: true, id: 'jira', label: 'Jira', pattern: 'PROJ-\\d+',
      urlTemplate: 'https://example.atlassian.net/browse/$0',
    }],
    onHideTooltip: vi.fn(), onShowFilePopover: vi.fn(),
  });
  let links: ILink[] = [];
  provider.provideLinks(1, result => { links = result ?? []; });

  expect(links.map(({ range, text }) => ({ range, text }))).toEqual([
    { range: { start: { x: 5, y: 1 }, end: { x: 11, y: 1 } }, text: 'PROJ-42' },
  ]);
  // SAFETY: Link activation only reads the modifier flag from the mouse event.
  links[0].activate({ ctrlKey: false } as MouseEvent, links[0].text);
  expect(onOpenUrl).not.toHaveBeenCalled();
  // SAFETY: As above.
  links[0].activate({ ctrlKey: true } as MouseEvent, links[0].text);
  expect(onOpenUrl).toHaveBeenCalledWith('https://example.atlassian.net/browse/PROJ-42');
  // SAFETY: Hover passes the event straight to the tooltip callback.
  links[0].hover?.({} as MouseEvent, links[0].text);
  expect(onShowTooltip.mock.calls[0].slice(1)).toEqual(['https://example.atlassian.net/browse/PROJ-42', 'Ctrl+Click to open']);
});

it('provides no links for a line without matches', () => {
  vi.stubGlobal('navigator', { platform: 'Linux' });
  // SAFETY: The provider reads only this public terminal buffer surface.
  const terminal = { buffer: { active: { getLine: (index: number) => index === 0 ? { translateToString: () => 'nothing here' } : undefined } } } as Terminal;
  const provider = createCustomLinkProvider({
    terminal, workingDirectory: '/repo', customLinks: [],
    onOpenUrl: vi.fn(), onShowTooltip: vi.fn(), onHideTooltip: vi.fn(), onShowFilePopover: vi.fn(),
  });
  const callback = vi.fn();
  provider.provideLinks(1, callback);
  expect(callback).toHaveBeenCalledWith(undefined);
});
