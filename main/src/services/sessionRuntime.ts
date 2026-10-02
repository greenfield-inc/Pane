import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import path from 'node:path';
import { parseWSLPath, windowsPathToWSLMount, type WSLContext } from '../utils/wslUtils';

type SessionRuntime = Pick<OrchestrationSessionRecord, 'runtime' | 'wslDistribution'>;

export function sessionRuntimePath(hostPath: string, runtime?: SessionRuntime): string {
  if (runtime?.runtime !== 'wsl') return hostPath;
  const absolutePath = process.platform !== 'win32' && path.win32.isAbsolute(hostPath) ? hostPath : path.resolve(hostPath);
  const unc = parseWSLPath(absolutePath);
  if (unc) {
    if (unc.distro.toLowerCase() !== runtime.wslDistribution?.toLowerCase()) throw new Error('Session path belongs to a different WSL distribution');
    return unc.linuxPath;
  }
  return windowsPathToWSLMount(absolutePath);
}

export function sessionWSLContext(runtime: SessionRuntime, hostPath: string): WSLContext | null {
  if (runtime.runtime !== 'wsl') return null;
  if (!runtime.wslDistribution) throw new Error('WSL Session requires a distribution');
  return { enabled: true, distribution: runtime.wslDistribution, linuxPath: sessionRuntimePath(hostPath, runtime) };
}
