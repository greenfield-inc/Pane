import {
  CreatePanelRequest,
  PanelEventType,
  SessionPanelLayout,
  ToolPanel,
} from '../../../shared/types/panels';
import { JsonValue } from '../../../shared/validation/boundaryDecoder';

let hostGeneration = 0;

export const panelApi = {
  /** Called synchronously when the window switches to another host, before any of its reads. */
  invalidateHostLoads(): void {
    hostGeneration += 1;
  },

  /** Work started under an older value belongs to a host this window has switched away from. */
  hostGeneration(): number {
    return hostGeneration;
  },

  async createPanel(request: CreatePanelRequest): Promise<ToolPanel> {
    const response = await window.electronAPI.panels.createPanel(
      request.sessionId, 
      request.type, 
      request.title || '', 
      request.initialState
    );
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to create panel');
    }
    return response.data;
  },
  
  async deletePanel(panelId: string): Promise<void> {
    const response = await window.electronAPI.panels.deletePanel(panelId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to delete panel');
    }
  },
  
  async updatePanel(panelId: string, updates: Partial<ToolPanel>): Promise<void> {
    // If only updating title, use renamePanel for backward compatibility
    if (Object.keys(updates).length === 1 && updates.title !== undefined) {
      const response = await window.electronAPI.panels.renamePanel(panelId, updates.title || '');
      if (!response.success) {
        throw new Error(response.error || 'Failed to update panel');
      }
    } else {
      // Use the full update handler for state and other updates
      const response = await window.electronAPI.invoke('panels:update', panelId, updates);
      if (!response.success) {
        throw new Error(response.error || 'Failed to update panel');
      }
    }
  },
  
  async loadPanelsForSession(sessionId: string): Promise<ToolPanel[]> {
    for (;;) {
      const generation = hostGeneration;
      const response = await window.electronAPI.panels.getSessionPanels(sessionId);
      // Existing callers apply this list to the store immediately. Never let
      // an outgoing host's delayed response repopulate it after a switch.
      if (generation !== hostGeneration) continue;
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load panels');
      }
      return response.data;
    }
  },
  
  async getActivePanel(sessionId: string): Promise<ToolPanel | null> {
    const panels = await this.loadPanelsForSession(sessionId);
    return panels.find(panel => panel.state.isActive) || null;
  },
  
  async setActivePanel(sessionId: string, panelId: string): Promise<void> {
    const response = await window.electronAPI.panels.setActivePanel(sessionId, panelId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to set active panel');
    }
  },
  
  async emitPanelEvent(panelId: string, eventType: PanelEventType, data: JsonValue): Promise<void> {
    await window.electronAPI.invoke('panels:emitEvent', panelId, eventType, data);
  },

  async getLayout(sessionId: string): Promise<SessionPanelLayout | null> {
    const response = await window.electronAPI.invoke('panels:get-layout', sessionId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to get panel layout');
    }
    return response.data ?? null;
  },

  async setLayout(sessionId: string, layout: SessionPanelLayout | null): Promise<void> {
    const response = await window.electronAPI.invoke('panels:set-layout', sessionId, layout);
    if (!response.success) {
      throw new Error(response.error || 'Failed to set panel layout');
    }
  },

  async clearPanelUnviewedContent(panelId: string): Promise<void> {
    // Clear the hasUnviewedContent flag and set status to 'stopped' for AI panels
    const response = await window.electronAPI.invoke('panels:clearUnviewedContent', panelId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to clear unviewed content');
    }
  }
};
