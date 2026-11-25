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

/** A saved login an agent filled: `<project>/<NAME>`, the site and the agent. */
export interface BrowserLoginUse { login: string; site: string; agent: string }

/** What main tells a browser tab to show under its address bar (`BROWSER_TAB_NOTICE_CHANNEL`). */
export type BrowserTabNotice =
  /** "This page wants to open <app>. Open · Cancel": the page asked for an app link (zoommtg:). */
  | { kind: 'app'; id: string; app: string | null; scheme: string }
  /** "<site> won't sign in here. Open this page in your browser": a sign-in refused Pane's browser; `url` is the page the tab was on. */
  | { kind: 'sign-in'; site: string; url: string }
  /** "Downloaded <name> · Show in folder", or "<agent> downloaded <name>" for a file in the Pane's scratch folder. */
  | { kind: 'downloaded'; name: string; file: string; agent?: string }
  /** "<agent> filled <login> on <site>": a saved login went into this tab's page. */
  | ({ kind: 'login' } & BrowserLoginUse);

export const BROWSER_TAB_NOTICE_CHANNEL = 'browser-panel:notice';
/** The person chose View live in a browser tab's page menu (`{ panelId }`). */
export const BROWSER_VIEW_LIVE_CHANNEL = 'browser-panel:view-live';
