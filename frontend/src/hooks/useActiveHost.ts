import { useMemo } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useRemoteRuntimeState } from './useRemoteRuntimeState';
import { getActiveHost, type ActiveHost } from '../utils/hostRepoActions';

/** The host that project, clone and folder requests reach right now. */
export function useActiveHost(): ActiveHost {
  const { connectionState } = useRemoteRuntimeState();
  const profiles = useConfigStore((state) => state.config?.remoteDaemon?.client.profiles);
  return useMemo(() => getActiveHost(connectionState, profiles ?? []), [connectionState, profiles]);
}
