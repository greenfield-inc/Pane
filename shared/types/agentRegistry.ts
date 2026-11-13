/** An agent the ACP Registry lists that Pane can install on this host (Settings > Agents). */
export interface RegistryAgent {
  id: string;
  name: string;
  /** The registry's current version; an installed agent moves to it on its next launch. */
  version: string;
  description?: string;
  iconUrl: string;
  /** `binary`: a download for this computer. `npx`: an npm package run with the person's Node.js. */
  kind: 'binary' | 'npx';
  /** The registry publishes a checksum for the download (npm packages are checked by npm). */
  verified: boolean;
  /** The version installed on this host, when it is installed. */
  installedVersion?: string;
  /** What this computer is missing to run it, such as Node.js. */
  needs?: string;
}

/** Settings > Agents' registry list, and why it may be out of date. */
export interface RegistryAgentList { agents: RegistryAgent[]; error?: string }
