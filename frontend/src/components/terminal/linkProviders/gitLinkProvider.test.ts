import { describe, expect, it, vi } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';
import { createGitLinkProvider } from './gitLinkProvider';
import type { LinkProviderConfig } from './types';

function providerFor(text: string) {
  // SAFETY: The provider only reads buffer.active.getLine(n).translateToString(); the stub covers that surface.
  const requestedLines: number[] = [];
  // SAFETY: The provider only reads buffer.active.getLine(n).translateToString(); the stub covers that surface.
  const terminal = Object.assign({} as Terminal, {
    buffer: { active: { getLine: (index: number) => { requestedLines.push(index); return { translateToString: () => text }; } } },
  });
  const config: LinkProviderConfig = {
    terminal,
    workingDirectory: '/repo',
    githubRemoteUrl: 'https://github.com/dcouple/pane',
    onShowTooltip: vi.fn(),
    onHideTooltip: vi.fn(),
    onShowFilePopover: vi.fn(),
    onActivateUrl: vi.fn(),
    urlHoverHint: 'HINT',
  };
  const provider = createGitLinkProvider(config);
  let links: ILink[] | undefined;
  // xterm passes 1-based buffer lines.
  provider.provideLinks(3, (result) => { links = result; });
  return { config, links: links ?? [], requestedLines };
}

describe('gitLinkProvider', () => {
  it('hands every activation and the shared hover hint to the router instead of gating on modifiers', () => {
    const { config, links, requestedLines } = providerFor('fix a1b2c3d closes #42 and dcouple/skills#7');
    expect(links.map((link) => link.text)).toEqual(['a1b2c3d', '#42', 'dcouple/skills#7']);
    // Reads the 0-based buffer line for the 1-based request and reports 1-based ranges on that row.
    expect(requestedLines).toEqual([2]);
    expect(links.map((link) => link.range.start.y)).toEqual([3, 3, 3]);

    // SAFETY: activate/hover only forward the event; the router reads modifier flags from it.
    const plain = { metaKey: false, ctrlKey: false, shiftKey: false } as MouseEvent;
    links[0].activate(plain, links[0].text);
    expect(config.onActivateUrl).toHaveBeenCalledWith('https://github.com/dcouple/pane/commit/a1b2c3d', plain);
    links[1].activate(plain, links[1].text);
    expect(config.onActivateUrl).toHaveBeenLastCalledWith('https://github.com/dcouple/pane/issues/42', plain);

    links[2].hover?.(plain, links[2].text);
    expect(config.onShowTooltip).toHaveBeenCalledWith(plain, 'https://github.com/dcouple/skills/issues/7', 'HINT');
  });
});
