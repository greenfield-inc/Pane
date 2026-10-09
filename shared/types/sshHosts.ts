/** The hidden, project-free Session that owns the SSH view's terminal tabs. */
export const SSH_HOSTS_SESSION_ID = '__ssh_hosts_session__';

export interface SshHostList {
  /** Concrete Host aliases from the SSH config, in file order. */
  hosts: string[];
  /** Aliases with at least one open tab in the SSH view, including hosts the config no longer lists. */
  openHosts: string[];
}

export interface SshHostOpenResult {
  sessionId: string;
  panelId: string;
}
