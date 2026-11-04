import { createRoot } from 'react-dom/client';
import { FileEditorView } from '../../frontend/src/components/panels/editor/FileEditorView';
import { ThemeContext } from '../../frontend/src/contexts/themeContextValue';
import { DEFAULT_APPEARANCE } from '../../shared/types/appearance';

const html = document.getElementById('html-source')!.textContent!;
interface IpcRequest { sessionId?: string; filePath?: string; content?: string }
const calls: Array<{ channel: string; request: IpcRequest }> = [];
const log = document.getElementById('ipc-log')!;
Object.assign(window, {
  electronAPI: {
    invoke: async (channel: string, request: IpcRequest) => {
      calls.push({ channel, request });
      log.textContent = JSON.stringify(calls.filter(call => call.channel !== 'git:file-status'));
      if (channel === 'file:read') return { success: true, content: html };
      if (channel === 'file:write') return { success: true };
      if (channel === 'git:file-status') return { success: true, data: { status: 'clean' } };
      if (channel === 'panels:open-html-file') return { success: true, data: { id: 'browser-1', sessionId: 'test-session', type: 'browser', title: 'page.html', state: { isActive: true, customState: {} }, metadata: {} } };
      if (channel === 'panels:set-active') return { success: true };
      throw new Error(`Unexpected IPC: ${channel}`);
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <ThemeContext.Provider value={{ theme: 'light', appearance: DEFAULT_APPEARANCE, prefersDark: false, activeSystemSlot: undefined, highContrast: false, setTheme: async () => {}, setAppearance: async () => {} }}>
    <FileEditorView sessionId="test-session" filePath="site/page.html" initialState={{ filePath: 'site/page.html', isDirty: false, isPreview: true }} />
  </ThemeContext.Provider>,
);
