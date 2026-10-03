import { create } from 'zustand';
import type { PaneChatAgent } from '../../../shared/types/paneChat';

export interface WorkspaceEntryLaunchFailure {
  projectId: number;
  agentType: PaneChatAgent;
  agentTitle: string;
  initialCommand: string;
  message: string;
}

interface WorkspaceEntryState {
  launchFailure: WorkspaceEntryLaunchFailure | null;
  setLaunchFailure: (failure: WorkspaceEntryLaunchFailure) => void;
  clearLaunchFailure: () => void;
}

export const useWorkspaceEntryStore = create<WorkspaceEntryState>(set => ({
  launchFailure: null,
  setLaunchFailure: launchFailure => set({ launchFailure }),
  clearLaunchFailure: () => set({ launchFailure: null }),
}));
