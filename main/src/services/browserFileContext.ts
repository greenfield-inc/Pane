import { PathResolver } from '../utils/pathResolver';
import { parseWSLPath, wslMountToWindowsPath } from '../utils/wslUtils';
import { isOrchestrationInternalSessionId } from '../../../shared/types/orchestrationSession';
import type { AppServices } from '../ipc/types';
import type { Session } from '../types/session';

/** Browser files use the pane's runtime, including project-less Session panes. */
export async function browserFileContext(services: AppServices, pane: Session) {
  const context = services.sessionManager.getProjectContext(pane.id);
  let resolver = context?.pathResolver;
  if (!resolver && pane.isHidden && isOrchestrationInternalSessionId(pane.id)) {
    const manager = services.orchestrationSessionManager;
    const owner = await manager?.sessionIdForPane(pane.id);
    const runtime = owner ? await manager?.get({ sessionId: owner }) : undefined;
    resolver = new PathResolver({
      path: pane.worktreePath,
      wsl_enabled: process.platform === 'win32' && runtime?.runtime === 'wsl',
      wsl_distribution: runtime?.wslDistribution,
    });
  }
  if (!resolver) throw new Error(`No Pane repo found for pane ${pane.id}`);
  const pathResolver = resolver;
  return {
    pathResolver,
    toFileSystem: (value: string) => {
      if (pathResolver.environment !== 'wsl') return pathResolver.toFileSystem(value);
      if (/^[a-z]:[\\/]/i.test(value)) return value;
      const unc = parseWSLPath(value);
      const distro = parseWSLPath(pathResolver.toFileSystem('/'))?.distro;
      if (unc && unc.distro.toLowerCase() !== distro?.toLowerCase()) return value;
      const linuxPath = unc?.linuxPath ?? value;
      const mountedPath = wslMountToWindowsPath(linuxPath);
      if (mountedPath !== linuxPath) return mountedPath;
      return pathResolver.toFileSystem(linuxPath);
    },
  };
}
