import type { ILink, ILinkProvider } from '@xterm/xterm';
import { matchCustomLinks } from '../../../utils/customLinkMatcher';
import type { LinkProviderConfig } from './types';
import { isMac, getModifierKeyName } from '../../../utils/platformUtils';

/** Links the text matching the user's own patterns from Settings › Links, such as issue keys. */
export function createCustomLinkProvider(config: LinkProviderConfig): ILinkProvider {
  // xterm asks again whenever the pointer moves to another row; only the newest answer may reach it.
  let latest: AbortController | null = null;

  return {
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void) {
      latest?.abort();
      const request = new AbortController();
      latest = request;

      const line = config.terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const isMacPlatform = isMac();
      const modifierKey = getModifierKeyName();
      // Trimmed so a pattern anchored with $ matches where the text ends, not after the row's padding.
      void matchCustomLinks(line.translateToString(true), config.customLinks ?? [], request.signal).then(({ matches }) => {
        // A reply for a row the pointer already left would land in xterm's answer for the new row.
        if (request.signal.aborted) return;
        const links = matches.map((match): ILink => ({
          range: {
            start: { x: match.start + 1, y: lineNumber },
            end: { x: match.end, y: lineNumber },
          },
          text: match.text,
          activate: (event: MouseEvent) => {
            if (isMacPlatform ? event.metaKey : event.ctrlKey) {
              config.onOpenUrl(match.url);
            }
          },
          hover: (event: MouseEvent) => {
            config.onShowTooltip(event, match.url, `${modifierKey}+Click to open`);
          },
          leave: () => {
            config.onHideTooltip();
          },
        }));
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
