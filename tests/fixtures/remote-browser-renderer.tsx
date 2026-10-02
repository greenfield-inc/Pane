import React from 'react';
import { createRoot } from 'react-dom/client';
import BrowserPanel from '../../frontend/src/components/panels/browser/BrowserPanel';
import '../../frontend/src/index.css';
import type { ToolPanel } from '../../shared/types/panels';

const panel: ToolPanel = await window.electronAPI.invoke('preview-test:panel');
createRoot(document.getElementById('root')!).render(<BrowserPanel panel={panel} isActive />);
