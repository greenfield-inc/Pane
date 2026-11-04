import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProjectSettings from '../src/components/ProjectSettings';
import type { Project } from '../src/types/project';
import '../src/index.css';

// Only the Electron transport is faked: project updates are recorded, and the
// branch and config-file lookups answer per path, and each repo has two variables.
type ProjectUpdate = { projectId: string; updates: Partial<Project> };
const updates: ProjectUpdate[] = [];
const branchFor = (path: string) => (path.endsWith('repo-a') ? 'main-a' : 'main-b');
Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  git: { detectBranch: async (path: string) => ({ success: true, data: branchFor(path) }) },
  projects: {
    detectConfig: async () => ({ success: true, data: null }),
    getEnvVars: async () => ({ success: true, data: [
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
      { key: 'STRIPE_SECRET_KEY', source: 'secret', project: 'stripe', name: 'STRIPE_SECRET_KEY' },
    ] }),
    update: async (projectId: string, change: Partial<Project>) => { updates.push({ projectId, updates: change }); return { success: true, data: null }; },
  },
} });

const repo = (id: number, name: string, runScript: string): Project => ({
  id, name, path: `/test/${name}`, run_script: runScript, active: id === 1,
  created_at: '2026-01-01', updated_at: '2026-01-01',
});
const projects = { a: repo(1, 'repo-a', 'pnpm dev'), b: repo(2, 'repo-b', 'cargo run') };

declare global {
  interface Window { projectSettingsTest: { show: (key: 'a' | 'b') => void; updates: () => Array<{ projectId: string; updates: object }> } }
}

function Fixture() {
  const [project, setProject] = useState<Project>(projects.a);
  window.projectSettingsTest = { show: key => setProject(projects[key]), updates: () => updates };
  return <ProjectSettings project={project} isOpen onClose={() => undefined} onUpdate={() => undefined} onDelete={() => undefined} />;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
