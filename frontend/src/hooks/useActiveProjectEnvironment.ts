import { useEffect, useState } from 'react';
import { API } from '../utils/api';
import { useSessionStore } from '../stores/sessionStore';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import type { Project } from '../types/project';

/**
 * Environment of the active session's project (`macos` | `windows` | `linux`
 * | `wsl`), or undefined when no session is active or the project is unknown.
 * Mirrors how SessionView resolves the environment for Add Tool presets.
 */
export function useActiveProjectEnvironment(): ProjectEnvironment | undefined {
  const projectId = useSessionStore((state) => {
    if (!state.activeSessionId) return undefined;
    if (state.activeMainRepoSession?.id === state.activeSessionId) return state.activeMainRepoSession.projectId;
    return state.sessions.find((session) => session.id === state.activeSessionId)?.projectId;
  });
  const [environment, setEnvironment] = useState<ProjectEnvironment | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (projectId === undefined) {
      setEnvironment(undefined);
      return undefined;
    }
    API.projects.getAll()
      .then((response) => {
        if (cancelled || !response.success || !response.data) return;
        const project = response.data.find((candidate: Project) => candidate.id === projectId);
        setEnvironment(project?.environment);
      })
      .catch(() => {
        if (!cancelled) setEnvironment(undefined);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  return environment;
}
