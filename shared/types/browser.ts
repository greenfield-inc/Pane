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

