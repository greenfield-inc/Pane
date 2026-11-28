import { useEffect, useState } from 'react';
import type { MachineState } from '../../../shared/types/machineConnections';

/** Every machine the desktop keeps a connection to, live; null until first listed. */
export function useMachineStates(): MachineState[] | null {
  const [states, setStates] = useState<MachineState[] | null>(() => window.electronAPI?.machines ? null : []);
  useEffect(() => {
    const api = window.electronAPI?.machines;
    if (!api) return;
    let live = true;
    void api.list().then(list => { if (live) setStates(list); }).catch(() => { if (live) setStates([]); });
    const unsubscribe = api.onEvent(event => { if (event.type === 'machines') setStates(event.machines); });
    return () => { live = false; unsubscribe(); };
  }, []);
  return states;
}
