import type React from 'react';
import { Terminal, GitBranch, FileCode, FileDiff, FileText, FolderTree, BarChart3, Globe } from 'lucide-react';
import type { EditorPanelState, ToolPanel, ToolPanelType } from '../../../../shared/types/panels';
import { getCliBrandIcon } from '../ui/brandIconRegistry';

/** The tab icon for a panel type; an agent terminal gets its CLI's brand icon. Shared by desktop and the Remote Pane PWA. */
export function getPanelIcon(type: ToolPanelType, panel?: ToolPanel, iconClass = 'w-4 h-4'): React.ReactNode {
  switch (type) {
    case 'terminal': {
      if (panel?.title) {
        const brandIcon = getCliBrandIcon(panel.title, iconClass);
        if (brandIcon) return brandIcon;
      }
      return <Terminal className={iconClass} />;
    }
    case 'diff':
      return <GitBranch className={iconClass} />;
    case 'explorer':
      return <FolderTree className={iconClass} />;
    case 'editor': {
      // SAFETY: The panel type discriminator determines the custom-state shape.
      const state = panel?.state?.customState as EditorPanelState | undefined;
      return state?.diff ? <FileDiff className={iconClass} /> : <FileText className={iconClass} />;
    }
    case 'logs':
      return <FileCode className={iconClass} />;
    case 'dashboard':
      return <BarChart3 className={iconClass} />;
    case 'browser':
      return <Globe className={iconClass} />;
    default:
      return null;
  }
}
