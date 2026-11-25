import { isReadOnlyProfile } from '@/auth/access';

import { useDaemon } from './DaemonProvider';

/** Whether this phone only watches the computer it's on: every control that types, runs, answers or changes something hides. */
export function useReadOnlyHost(): boolean {
  return isReadOnlyProfile(useDaemon().profile);
}
