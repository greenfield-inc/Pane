import { createContext } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { GitCommands, Session } from '../types/session';
import type { ConfiguredIde } from '../../../shared/utils/ideCommands';

export interface SessionContextValue {
  sessionId: string;
  workingDirectory: string;
  projectId: string;
  projectName?: string;
  session: Session;
  gitBranchActions?: Array<{
    id: string;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
    disabled: boolean;
    variant: 'default' | 'success' | 'danger';
    description: string;
    shortcut?: string;
    disabledReason?: string;
  }>;
  isMerging?: boolean;
  gitCommands?: GitCommands;
  onOpenIDEWithCommand?: (command?: string) => void;
  onOpenUrlInBrowser?: (url: string, title: string) => Promise<void>;
  onConfigureIDE?: () => void;
  onSetTracking?: () => void;
  trackingBranch?: string | null;
  configuredIDE?: ConfiguredIde;
  isRemoteMode?: boolean;
}

export const SessionContext = createContext<SessionContextValue | undefined>(undefined);
