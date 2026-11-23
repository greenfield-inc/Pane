import { useEffect, useRef } from 'react';
import { Copy, ExternalLink, Globe } from 'lucide-react';
import { PopoverButton, TerminalPopover } from '../terminal/TerminalPopover';
import { isWebLink, linkDestination, openInPaneTab, opensLink, swapsDestination } from '../../utils/openLink';
import { copyTerminalText } from '../../utils/terminalClipboard';
import { getModifierKeyName } from '../../utils/platformUtils';
import { useConfigStore } from '../../stores/configStore';
import { closeLinkPopover, keepLinkPopover, hoverLink, leaveLink, leaveLinkPopover, showLinkPopover, useLinkPopoverStore } from './linkPopoverState';

interface LinkUnderPointer {
  element: HTMLElement;
  url: string;
  paneId?: string;
}

/**
 * A web link inside an element marked `data-link-pane` (its value is the Pane id, or empty for
 * none): an `<a href>` with an absolute http(s) address, or any element with `data-link-url`.
 */
function linkAt(target: EventTarget | null): LinkUnderPointer | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('a[href], [data-link-url]');
  const scope = element?.closest<HTMLElement>('[data-link-pane]');
  if (!element || !scope) return null;
  const url = element.dataset.linkUrl ?? element.getAttribute('href') ?? '';
  if (!isWebLink(url)) return null;
  return { element, url, paneId: scope.dataset.linkPane || undefined };
}

const crossesLink = (event: MouseEvent, link: LinkUnderPointer) =>
  !(event.relatedTarget instanceof Node && link.element.contains(event.relatedTarget));

/** What the popover's actions do on this screen. */
export interface LinkActions {
  openInPane(paneId: string, url: string): Promise<void>;
  openInBrowser(url: string): Promise<void>;
  copy(url: string): Promise<void>;
}

/** The desktop's: a Pane tab through main, the system browser, and the clipboard of the machine you are at. */
const DESKTOP_ACTIONS: LinkActions = {
  openInPane: openInPaneTab,
  openInBrowser: async url => { await window.electronAPI.openExternal(url); },
  copy: async url => { await copyTerminalText(url); },
};

/**
 * Pane's link popover (Open in Pane, Open in browser, Copy link), mounted once per window. It
 * serves every link inside a `data-link-pane` element: a plain click opens the link where
 * Settings > Links says, Cmd-click or Ctrl-click in the other place, and hovering or right-clicking
 * shows the popover. The terminal shows it through hoverLink and showLinkPopover.
 */
export function LinkPopoverHost({ actions = DESKTOP_ACTIONS }: { actions?: LinkActions }) {
  const target = useLinkPopoverStore(state => state.target);
  const openIn = useConfigStore(state => state.config?.browser?.openLinksIn);
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; }, [actions]);

  useEffect(() => {
    const onOver = (event: MouseEvent) => {
      const link = linkAt(event.target);
      if (!link || !crossesLink(event, link)) return;
      const rect = link.element.getBoundingClientRect();
      hoverLink({ url: link.url, paneId: link.paneId, x: rect.left, y: rect.bottom + 4, flipY: rect.top - 4 });
    };
    const onOut = (event: MouseEvent) => {
      const link = linkAt(event.target);
      if (link && crossesLink(event, link)) leaveLink();
    };
    const onContextMenu = (event: MouseEvent) => {
      const link = linkAt(event.target);
      // A right-click inside selected text keeps the page's menu, with its Copy.
      if (!link || window.getSelection()?.isCollapsed === false) return;
      event.preventDefault();
      showLinkPopover({ url: link.url, paneId: link.paneId, x: event.clientX, y: event.clientY });
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !opensLink(event)) return;
      const link = linkAt(event.target);
      if (!link) return;
      // A clicked link has done its job, so a hover popover waiting to show never does.
      closeLinkPopover();
      if (!(link.element instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      const { url, paneId } = link;
      const opening = linkDestination(url, { paneId, openIn: useConfigStore.getState().config?.browser?.openLinksIn, swap: swapsDestination(event) }) === 'pane' && paneId
        // A link whose Pane tab can't open goes to the browser instead.
        ? actionsRef.current.openInPane(paneId, url).catch(error => {
          console.error('[LinkPopover] Could not open the link in a Pane tab, so it opens in the browser:', error);
          return actionsRef.current.openInBrowser(url);
        })
        : actionsRef.current.openInBrowser(url);
      void opening.catch(error => console.error('[LinkPopover] Could not open the link:', error));
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('click', onClick);
    return () => {
      closeLinkPopover();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('click', onClick);
    };
  }, []);

  // Scrolling moves the link out from under the popover, so it closes. Escape closes it. A right-click
  // popover keeps the key from the focused element (a terminal would send it to its program); a hover
  // popover lets it through, so Escape still reaches what the person was typing into.
  useEffect(() => {
    if (!target) return;
    const close = () => closeLinkPopover();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (target.pinned) {
        event.preventDefault();
        event.stopPropagation();
      }
      closeLinkPopover();
    };
    document.addEventListener('scroll', close, { capture: true, passive: true });
    document.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('scroll', close, { capture: true });
      document.removeEventListener('wheel', close, { capture: true });
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [target]);

  if (!target) return null;
  const { url, paneId } = target;
  const inPane = Boolean(paneId) && isWebLink(url);
  const swapped = linkDestination(url, { paneId, openIn, swap: true }) === 'pane' ? 'Pane' : 'browser';
  const act = (action: () => Promise<void>, failure: string) => {
    closeLinkPopover();
    void action().catch(error => console.error(`[LinkPopover] ${failure}:`, error));
  };

  return (
    <TerminalPopover visible x={target.x} y={target.y} flipY={target.flipY} onClose={closeLinkPopover} className="w-64"
      onMouseEnter={keepLinkPopover} onMouseLeave={leaveLinkPopover}>
      <div className="px-3 pb-1.5 pt-1" data-testid="link-popover">
        <div className="truncate text-xs text-text-secondary" title={url}>{url}</div>
        {inPane && <div className="text-xs text-text-tertiary">{getModifierKeyName()}-click opens in {swapped}</div>}
      </div>
      {inPane && paneId && (
        <PopoverButton onClick={() => act(() => actions.openInPane(paneId, url), 'Could not open the link in Pane')}>
          <span className="flex items-center gap-2"><Globe className="h-4 w-4" />Open in Pane</span>
        </PopoverButton>
      )}
      <PopoverButton onClick={() => act(() => actions.openInBrowser(url), 'Could not open the link in the browser')}>
        <span className="flex items-center gap-2"><ExternalLink className="h-4 w-4" />Open in browser</span>
      </PopoverButton>
      <PopoverButton onClick={() => act(() => actions.copy(url), 'Could not copy the link')}>
        <span className="flex items-center gap-2"><Copy className="h-4 w-4" />Copy link</span>
      </PopoverButton>
    </TerminalPopover>
  );
}
