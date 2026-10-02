import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { parseWSLPath, windowsPathToWSLMount, type WSLContext } from '../utils/wslUtils';

type SessionRuntime = Pick<OrchestrationSessionRecord, 'runtime' | 'wslDistribution'>;

export function sessionRuntimePath(hostPath: string, runtime?: SessionRuntime): string {
  if (runtime?.runtime !== 'wsl') return hostPath;
  const unc = parseWSLPath(hostPath);
  if (unc) {
    if (unc.distro.toLowerCase() !== runtime.wslDistribution?.toLowerCase()) throw new Error('Session path belongs to a different WSL distribution');
    return unc.linuxPath;
  }
  return windowsPathToWSLMount(hostPath);
}

export function sessionWSLContext(runtime: SessionRuntime, hostPath: string): WSLContext | null {
  if (runtime.runtime !== 'wsl') return null;
  if (!runtime.wslDistribution) throw new Error('WSL Session requires a distribution');
  return { enabled: true, distribution: runtime.wslDistribution, linuxPath: sessionRuntimePath(hostPath, runtime) };
}
