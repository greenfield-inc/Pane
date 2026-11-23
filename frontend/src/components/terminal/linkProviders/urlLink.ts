import type { ILink } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';

/** A web link's behavior: a click opens it, and resting on it shows the link popover. */
export function urlLinkHandlers(config: LinkProviderConfig, url: string): Pick<ILink, 'activate' | 'hover' | 'leave'> {
  return {
    activate: (event: MouseEvent) => config.onOpenUrl(url, event),
    hover: (event: MouseEvent) => config.onHoverUrl(url, event),
    leave: () => config.onLeaveUrl(),
  };
}
