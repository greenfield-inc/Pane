/** Where links from your work open: a Pane browser tab beside where they started, or the system browser. */
export type LinksOpenIn = 'pane' | 'system';

/** Settings > Browser and Settings > Links (docs/BROWSER_AGENTS.md). */
export interface BrowserSettings {
  /** Agents in a Pane get the browser_* tools on that Pane's browser tabs (on by default). */
  agentTools: boolean;
  /** Settings > Links > Open links in (Pane's browser by default). */
  openLinksIn: LinksOpenIn;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { agentTools: true, openLinksIn: 'pane' };

/** What main tells a browser tab to show under its address bar (`BROWSER_TAB_NOTICE_CHANNEL`). */
export type BrowserTabNotice =
  /** "This page wants to open <app>. Open · Cancel": the page asked for an app link (zoommtg:). */
  | { kind: 'app'; id: string; app: string | null; scheme: string }
  /** A sign-in that fails in an embedded browser went to the system browser instead. */
  | { kind: 'sent-out'; site: string }
  /** "Downloaded <name> · Show in folder", or "<agent> downloaded <name>" for a file in the Pane's scratch folder. */
  | { kind: 'downloaded'; name: string; file: string; agent?: string };

export const BROWSER_TAB_NOTICE_CHANNEL = 'browser-panel:notice';
