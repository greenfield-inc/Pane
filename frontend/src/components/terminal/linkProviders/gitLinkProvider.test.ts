import { expect, it, vi } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';
import { createGitLinkProvider } from './gitLinkProvider';

/** The commit links the provider finds on one line of terminal output. */
function commitsIn(text: string): string[] {
  // SAFETY: The provider reads only this public terminal buffer surface.
  const terminal = { buffer: { active: { getLine: (index: number) => index === 0 ? { translateToString: () => text } : undefined } } } as Terminal;
  const provider = createGitLinkProvider({
    terminal, workingDirectory: '/repo', githubRemoteUrl: 'https://github.com/acme/app',
    onOpenUrl: vi.fn(), onHoverUrl: vi.fn(), onLeaveUrl: vi.fn(),
    onShowTooltip: vi.fn(), onHideTooltip: vi.fn(), onShowFilePopover: vi.fn(),
  });
  let links: ILink[] = [];
  provider.provideLinks(0, result => { links = result ?? []; });
  return links.map(link => link.text).filter(text => !text.includes('#'));
}

it('links a commit hash standing alone', () => {
  expect(commitsIn('cc3ab6eae Links: open where you click')).toEqual(['cc3ab6eae']);
  expect(commitsIn('HEAD is now at 4b881c8ee6d1b2a3c4d5e6f708192a3b4c5d6e7f')).toEqual(['4b881c8ee6d1b2a3c4d5e6f708192a3b4c5d6e7f']);
});

it.each([
  ['a timestamp', 'took 1795407494692 ms'],
  ['a word made of hex letters', 'the deadbeef and facade cases'],
  ['part of a UUID', 'id 6d95f4ea-238f-4bf5-b78f-cc5a6ef21527'],
  ['hex in a path', 'wrote /tmp/pane-1a2b3c4d5e/out.log'],
  ['hex inside a file name', 'bundle.9f8e7d6c5.js'],
])('links nothing in %s', (_case, text) => {
  expect(commitsIn(text)).toEqual([]);
});
