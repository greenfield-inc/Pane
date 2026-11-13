import { CONFIGURED_AGENT_IDS, configuredAgent } from '../agents';

export interface WorktreeFileSyncEntry {
  id: string;
  path: string;
  enabled: boolean;
  recursive: boolean;
}

// Small/critical entries come first; heavyweight directories (node_modules)
// last so credentials and config land before slow recursive copies.
export const DEFAULT_WORKTREE_FILE_SYNC_ENTRIES: WorktreeFileSyncEntry[] = [
  { id: 'env', path: '.env*', enabled: true, recursive: true },
  // Each configured agent's project config folder (`terminal.configDir` in the agents config).
  ...CONFIGURED_AGENT_IDS.flatMap((id): WorktreeFileSyncEntry[] => {
    const path = configuredAgent(id).terminal.configDir;
    return path ? [{ id, path, enabled: true, recursive: false }] : [];
  }),
  { id: 'continue', path: '.continue', enabled: true, recursive: false },
  { id: 'windsurf', path: '.windsurf', enabled: true, recursive: false },
  { id: 'amazonq', path: '.amazonq', enabled: true, recursive: false },
  { id: 'roo', path: '.roo', enabled: true, recursive: false },
  { id: 'cline', path: '.cline', enabled: true, recursive: false },
  { id: 'gemini', path: '.gemini', enabled: true, recursive: false },
  { id: 'junie', path: '.junie', enabled: true, recursive: false },
  { id: 'aider-conf', path: '.aider.conf.yml', enabled: true, recursive: false },
  { id: 'node_modules', path: 'node_modules', enabled: true, recursive: true },
];
