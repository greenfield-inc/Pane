import { create } from 'zustand';
import type { Project } from '../types/project';
import { API } from '../utils/api';

interface ProjectStore {
  projects: Project[];
  isLoaded: boolean;
  isLoading: boolean;
  isReordering: boolean;
  error: string | null;
  ensureLoaded: () => Promise<Project[] | null>;
  refresh: () => Promise<Project[] | null>;
  upsert: (project: Project) => void;
  reorder: (projectId: number, targetProjectId: number) => Promise<boolean>;
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  let loading: Promise<Project[] | null> | null = null;
  let saving: Promise<boolean> | null = null;
  let refreshRequested = false;
  const updatesDuringLoad = new Map<number, Project>();

  return {
    projects: [], isLoaded: false, isLoading: false, isReordering: false, error: null,
    ensureLoaded: () => get().isLoaded ? Promise.resolve(get().projects) : loading ?? get().refresh(),
    refresh: () => {
      // A refresh must observe the saved order, not replace an optimistic move.
      if (saving) return saving.then(() => get().refresh());
      if (loading) {
        refreshRequested = true;
        return loading;
      }
      set({ isLoading: true, error: null });
      loading = (async () => {
        try {
          for (;;) {
            refreshRequested = false;
            updatesDuringLoad.clear();
            const response = await API.projects.getAll();
            if (refreshRequested) continue;
            if (!response.success || !response.data) throw new Error(response.error || 'Failed to load repositories');
            // SAFETY: projects:get-all returns the typed project list from the main process.
            const loaded = response.data as Project[];
            const projects = loaded.map(project => updatesDuringLoad.get(project.id) ?? project);
            for (const project of updatesDuringLoad.values()) {
              if (!projects.some(existing => existing.id === project.id)) projects.push(project);
            }
            set({ projects, isLoaded: true });
            return projects;
          }
        } catch (cause) {
          set({ error: cause instanceof Error ? cause.message : 'Failed to load repositories' });
          return null;
        } finally {
          loading = null;
          set({ isLoading: false });
        }
      })();
      return loading;
    },
    upsert: project => {
      if (loading) updatesDuringLoad.set(project.id, project);
      set(state => ({
        projects: state.projects.some(existing => existing.id === project.id)
          ? state.projects.map(existing => existing.id === project.id ? { ...existing, ...project } : existing)
          : [...state.projects, project],
      }));
    },
    reorder: (projectId, targetProjectId) => {
      if (saving) return Promise.resolve(false);
      set({ isReordering: true, error: null });
      saving = (async () => {
        await loading;
        const previous = get().projects;
        const from = previous.findIndex(project => project.id === projectId);
        const to = previous.findIndex(project => project.id === targetProjectId);
        if (from < 0 || to < 0 || from === to) return false;
        const reordered = [...previous];
        const [moved] = reordered.splice(from, 1);
        reordered.splice(to, 0, moved);
        const projects = reordered.map((project, displayOrder) => ({ ...project, displayOrder }));
        const payload = projects.map(({ id, displayOrder }) => ({ id, displayOrder }));
        set({ projects });
        try {
          const response = await API.projects.reorder(payload);
          if (!response.success) throw new Error(response.error || 'Failed to reorder repositories');
          return true;
        } catch (cause) {
          // Restore order without losing project updates received during the save.
          const current = new Map(get().projects.map(project => [project.id, project]));
          const restored = previous.map(project => ({ ...project, ...current.get(project.id), displayOrder: project.displayOrder }));
          set({
            projects: [...restored, ...get().projects.filter(project => !previous.some(old => old.id === project.id))],
            error: cause instanceof Error ? cause.message : 'Failed to reorder repositories',
          });
          return false;
        }
      })().finally(() => {
        saving = null;
        set({ isReordering: false });
      });
      return saving;
    },
  };
});
