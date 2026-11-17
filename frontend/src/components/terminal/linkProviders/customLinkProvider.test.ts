import { afterEach, expect, it, vi } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';
import { findCustomLinks } from '../../../../../shared/utils/customLinks';
import type { CustomLinkMatchRequest } from '../../../utils/customLinkMatcher';
import { createCustomLinkProvider } from './customLinkProvider';

/** Answers like the real matcher worker, which runs findCustomLinks. */
class FakeWorker extends EventTarget {
  postMessage({ id, text, links }: CustomLinkMatchRequest): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id, matches: findCustomLinks(text, links) } })));
  }

  terminate(): void {}
}

afterEach(() => vi.unstubAllGlobals());

it('links a matching issue key and opens it on Ctrl+Click only', async () => {
  vi.stubGlobal('navigator', { platform: 'Linux' });
  vi.stubGlobal('Worker', FakeWorker);
  const onOpenUrl = vi.fn();
  const onShowTooltip = vi.fn();
  // xterm pads each row to the terminal width unless asked to trim.
  const row = 'see PROJ-42'.padEnd(80);
  // SAFETY: The provider reads only this public terminal buffer surface.
  const terminal = { buffer: { active: { getLine: (index: number) => index === 0 ? { translateToString: (trimRight?: boolean) => trimRight ? row.trimEnd() : row } : undefined } } } as Terminal;
  const provider = createCustomLinkProvider({
    terminal, workingDirectory: '/repo', onOpenUrl, onShowTooltip,
    customLinks: [{
      enabled: true, id: 'jira', label: 'Jira', pattern: 'PROJ-\\d+$',
      urlTemplate: 'https://example.atlassian.net/browse/$0',
    }],
    onHideTooltip: vi.fn(), onShowFilePopover: vi.fn(),
  });
  const links = await new Promise<ILink[]>((resolve) => provider.provideLinks(1, result => resolve(result ?? [])));

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

it('answers only the newest row when the pointer moves on before matching finishes', async () => {
  vi.stubGlobal('navigator', { platform: 'Linux' });
  vi.stubGlobal('Worker', FakeWorker);
  const rows = ['left PROJ-1', 'here PROJ-2'];
  // SAFETY: The provider reads only this public terminal buffer surface.
  const terminal = { buffer: { active: { getLine: (index: number) => rows[index] === undefined ? undefined : { translateToString: () => rows[index] } } } } as Terminal;
  const provider = createCustomLinkProvider({
    terminal, workingDirectory: '/repo', customLinks: [{ enabled: true, id: 'jira', label: 'Jira', pattern: 'PROJ-\\d+', urlTemplate: 'https://example.atlassian.net/browse/$0' }],
    onOpenUrl: vi.fn(), onShowTooltip: vi.fn(), onHideTooltip: vi.fn(), onShowFilePopover: vi.fn(),
  });
  const leftRow = vi.fn();
  provider.provideLinks(1, leftRow);
  const links = await new Promise<ILink[]>((resolve) => provider.provideLinks(2, result => resolve(result ?? [])));

  expect(links.map(link => link.text)).toEqual(['PROJ-2']);
  expect(leftRow).not.toHaveBeenCalled();
});
