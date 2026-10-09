import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileEditorView } from '../../frontend/src/components/panels/editor/FileEditorView';
import { ThemeContext } from '../../frontend/src/contexts/themeContextValue';
import { DEFAULT_APPEARANCE } from '../../shared/types/appearance';

const pending: Array<{ filePath: string; resolve: (value: { success: true; content: string }) => void }> = [];
const writes: Array<{ filePath: string; content?: string }> = [];
let notify = () => {};
Object.assign(window, {
  electronAPI: {
    invoke: async (channel: string, request: { filePath: string; content?: string }) => {
      if (channel === 'file:read') return new Promise(resolve => {
        pending.push({ filePath: request.filePath, resolve }); notify();
      });
      if (channel === 'file:write') { writes.push(request); notify(); return { success: true }; }
      if (channel === 'git:file-status') return { success: true, data: { status: 'clean' } };
      throw new Error(`Unexpected IPC: ${channel}`);
    },
  },
});

function Fixture() {
  const [filePath, setFilePath] = useState('a.txt');
  const [reopenedAt, setReopenedAt] = useState('initial');
  const [, rerender] = useState(0);
  notify = () => rerender(value => value + 1);
  return <ThemeContext.Provider value={{ theme: 'light', appearance: DEFAULT_APPEARANCE, prefersDark: false, activeSystemSlot: undefined, highContrast: false, setTheme: async () => {}, setAppearance: async () => {} }}>
    <button onClick={() => setFilePath('a.txt')}>Select A</button>
    <button onClick={() => setFilePath('b.txt')}>Select B</button>
    <button onClick={() => setReopenedAt(value => `${value}-again`)}>Reopen</button>
    <button onClick={() => { pending.shift()?.resolve({ success: true, content: 'disk content' }); notify(); }}>Resolve read</button>
    <output aria-label="Pending reads">{pending.map(read => read.filePath).join(',')}</output>
    <output aria-label="Saved files">{JSON.stringify(writes)}</output>
    <FileEditorView sessionId="test-session" filePath={filePath} initialState={{ filePath, reopenedAt, isDirty: false, isPreview: true }} />
  </ThemeContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
