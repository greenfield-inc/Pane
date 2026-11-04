import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HeadlessFileTree } from '../../frontend/src/components/panels/editor/FileEditor';

// A worktree with plans/cows.html, AGENTS.md and CLAUDE.md. Opening a file moves
// the active editor path the way FileEditor does; an HTML file opens in the
// browser instead, so the active editor path stays put.
const listing = new Map([
  ['', [
    { name: 'plans', path: 'plans', isDirectory: true },
    { name: 'AGENTS.md', path: 'AGENTS.md', isDirectory: false },
    { name: 'CLAUDE.md', path: 'CLAUDE.md', isDirectory: false },
  ]],
  ['plans', [{ name: 'cows.html', path: 'plans/cows.html', isDirectory: false }]],
]);
Object.assign(window, {
  electronAPI: {
    invoke: async (channel: string, request: { path: string }) => {
      if (channel === 'file:list') return { success: true, files: listing.get(request.path) ?? [] };
      throw new Error(`Unexpected IPC: ${channel}`);
    },
  },
});

function Fixture() {
  const [activePath, setActivePath] = useState<string | null>(null);
  const [opened, setOpened] = useState<string[]>([]);
  return <>
    <output aria-label="Active editor path">{activePath ?? ''}</output>
    <output aria-label="Opened">{opened.join(',')}</output>
    <HeadlessFileTree
      sessionId="test-session"
      selectedPath={activePath}
      onFileSelect={(file) => {
        if (!file) return;
        setOpened(prev => [...prev, file.path]);
        if (!file.path.endsWith('.html')) setActivePath(file.path);
      }}
      onHtmlPreview={() => {}}
    />
  </>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
