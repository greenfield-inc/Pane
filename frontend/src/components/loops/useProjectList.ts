import { useEffect, useState } from 'react';
import type { Project } from '../../types/project';
import { API } from '../../utils/api';

/** Every project, reread when one is added, changed or removed. */
export function useProjectList(): Project[] {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await API.projects.getAll().catch(() => null);
      if (!cancelled && response?.success && response.data) setProjects(response.data);
    };
    void load();
    window.addEventListener('project-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('project-changed', load);
    };
  }, []);
  return projects;
}
