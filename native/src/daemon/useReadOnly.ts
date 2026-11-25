import { isReadOnlyProfile, useAccessStore } from '@/auth/access';

import { useDaemon } from './DaemonProvider';

/** Whether this phone only watches the computer it's on: every control that types, runs, answers or changes something hides. */
export function useReadOnlyHost(): boolean {
  const { profile } = useDaemon();
  return useAccessStore(state => isReadOnlyProfile(profile, state.levels));
}
