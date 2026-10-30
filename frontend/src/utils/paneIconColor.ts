import type { Session } from '../types/session';

/** The branch icon's colour: the PR's state, else whether the Pane runs or failed. */
export function paneIconColor(session: Session): string {
  const gs = session.gitStatus;
  return gs?.prState
    ? gs.prState === 'MERGED' ? 'text-purple-400'
    : gs.prState === 'CLOSED' ? 'text-red-400'
    : 'text-green-400'
    : session.status === 'running' || session.status === 'initializing'
    ? 'text-status-success'
    : session.status === 'error'
    ? 'text-status-error'
    : 'text-text-tertiary';
}
