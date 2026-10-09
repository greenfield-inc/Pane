import { createRoot } from 'react-dom/client';
import { DocumentFilePreview } from '../../frontend/src/components/panels/editor/DocumentFilePreview';
import { ThemeContext } from '../../frontend/src/contexts/themeContextValue';
import { DEFAULT_APPEARANCE } from '../../shared/types/appearance';

Object.assign(window, { electronAPI: { invoke: async (channel: string) => {
  if (channel === 'file:preview-url') return 'https://preview.test/untrusted.html';
  if (channel === 'file:release-preview') return;
  throw new Error(`Unexpected IPC: ${channel}`);
} } });
createRoot(document.getElementById('root')!).render(
  <ThemeContext.Provider value={{ theme: 'light', appearance: DEFAULT_APPEARANCE, prefersDark: false, activeSystemSlot: undefined, highContrast: false, setTheme: async () => {}, setAppearance: async () => {} }}>
    <DocumentFilePreview sessionId="test-session" filePath="untrusted.html" fileName="untrusted.html" kind="html" />
  </ThemeContext.Provider>,
);
