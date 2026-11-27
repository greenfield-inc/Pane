import { tokenAccess } from '@shared/types/accessLevel';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

/** Whether this phone is paired Read only with a computer. Its token says so, whatever the computer says. */
export function isReadOnlyProfile(profile: RemotePaneConnectionProfile): boolean {
  return tokenAccess(profile.token) === 'read';
}
