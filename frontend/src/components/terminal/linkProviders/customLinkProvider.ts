import type { ILink, ILinkProvider } from '@xterm/xterm';
import { findCustomLinks } from '../../../../../shared/utils/customLinks';
import type { LinkProviderConfig } from './types';
import { isMac, getModifierKeyName } from '../../../utils/platformUtils';

/** Links the text matching the user's own patterns from Settings › Links, such as issue keys. */
export function createCustomLinkProvider(config: LinkProviderConfig): ILinkProvider {
  return {
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const line = config.terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const isMacPlatform = isMac();
      const modifierKey = getModifierKeyName();
      const links = findCustomLinks(line.translateToString(), config.customLinks ?? []).map((match): ILink => ({
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
    },
  };
}
