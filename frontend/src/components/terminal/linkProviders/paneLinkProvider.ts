import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';
import { PANE_LINK_REGEX, parsePaneLink } from '../paneLink';

export function createPaneLinkProvider(config: LinkProviderConfig): ILinkProvider {
  return {
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const rowIndex = lineNumber - 1;
      const line = config.terminal.buffer.active.getLine(rowIndex);
      if (!line) {
        callback(undefined);
        return;
      }
      const buffer = config.terminal.buffer.active;
      let firstLine = rowIndex;
      while (firstLine > 0 && buffer.getLine(firstLine)?.isWrapped) firstLine--;
      let lastLine = rowIndex;
      while (buffer.getLine(lastLine + 1)?.isWrapped) lastLine++;
      let text = '';
      for (let row = firstLine; row <= lastLine; row++) {
        text += buffer.getLine(row)?.translateToString(false) ?? '';
      }
      const links: ILink[] = [];
      PANE_LINK_REGEX.lastIndex = 0;
      for (const match of text.matchAll(PANE_LINK_REGEX)) {
        const url = match[0].replace(/[),;!?]+$/, '');
        if (!parsePaneLink(url)) continue;
        const start = match.index;
        const end = start + url.length;
        const cols = config.terminal.cols;
        const position = (offset: number) => ({
          x: (offset % cols) + 1,
          y: firstLine + Math.floor(offset / cols) + 1,
        });
        if (firstLine + Math.floor(start / cols) > rowIndex
          || firstLine + Math.floor((end - 1) / cols) < rowIndex) continue;
        links.push({
          range: {
            start: position(start),
            end: position(end),
          },
          text: url,
          activate: () => config.onOpenPane(url),
          hover: event => config.onShowTooltip(event, url, 'Open Pane'),
          leave: () => config.onHideTooltip(),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
