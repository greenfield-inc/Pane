import type { ListeningPortsSnapshot } from '@shared/types/listeningPorts';
import { phonePage } from '@shared/utils/phonePage';

/**
 * What a page tab shows. `web` loads `src` in the page view (and in Safari); `file` loads an HTML
 * file the phone reads through the computer, for when the computer serves no pages to phones.
 * The rest are states, each with its own screen. `address` is what the address row reads.
 */
export type BrowserPage =
  | { kind: 'web'; src: string; address: string }
  | { kind: 'file'; url: string; address: string }
  | { kind: 'loading'; address: string; host: string; /** Ask the computer for this port's phone address. */ request?: number }
  | { kind: 'refused'; address: string; host: string; port: number }
  | { kind: 'not-web'; address: string; host: string; port: number }
  | { kind: 'pages-off'; address: string; host: string; reason: string }
  | { kind: 'update'; address: string }
  | { kind: 'invalid'; address: string }
  | { kind: 'empty'; address: string };

export interface PortsRead {
  /** Null until the first read, or when the computer cannot list them. */
  ports: ListeningPortsSnapshot | null;
  /** The computer's Pane predates phone pages: it has no `ports:list`. */
  olderPane?: boolean;
}

/** Maps a page tab's saved, computer-relative URL to what the phone shows. */
export function browserPage(url: string, read: PortsRead, panelId: string): BrowserPage {
  if (!url) return { kind: 'empty', address: '' };
  let page;
  try {
    page = phonePage(url, read.ports, panelId);
  } catch {
    return { kind: 'invalid', address: url };
  }
  if (page.kind === 'frame') return { kind: 'web', src: page.src, address: page.address };
  const { address, host } = page;
  // An HTML file reads over the phone's own connection whenever the files address can't serve it.
  if (url.startsWith('file:')) return { kind: 'file', url, address };
  if (read.olderPane) return { kind: 'update', address };
  switch (page.cause) {
    case 'reading':
      return { kind: 'loading', address, host };
    case 'starting':
      return { kind: 'loading', address, host, request: page.request };
    case 'refused':
    case 'not-web':
      return { kind: page.cause, address, host, port: page.port ?? 0 };
    case 'pages-off':
      return { kind: 'pages-off', address, host, reason: page.offReason ?? page.reason };
    case 'invalid':
      return { kind: 'invalid', address };
  }
}

/** The address's host and the rest, so the row can show the path dimmed. A scheme is dropped. */
export function splitAddress(address: string): [string, string] {
  const bare = address.replace(/^[a-z]+:\/\//i, '');
  const slash = bare.indexOf('/');
  if (slash < 0) return [bare, ''];
  const rest = bare.slice(slash);
  return [bare.slice(0, slash), rest === '/' ? '' : rest];
}

/** An HTML file the computer sent as base64, as text. Throws on bytes that are not UTF-8. */
export function htmlFromBase64(data: string): string {
  return decodeURIComponent(atob(data).replace(/[\s\S]/g, byte => `%${byte.charCodeAt(0).toString(16).padStart(2, '0')}`));
}
