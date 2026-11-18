/** Settings > Browser (docs/BROWSER_AGENTS.md). */
export interface BrowserSettings {
  /** Agents in a Pane get the browser_* tools on that Pane's browser tabs (on by default). */
  agentTools: boolean;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { agentTools: true };
