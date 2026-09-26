import { v4 as uuidv4 } from 'uuid';
import { ToolPanel, CreatePanelRequest, PanelEventType, ToolPanelState, ToolPanelMetadata, ToolPanelType, LogsPanelState } from '../../../shared/types/panels';
import { getPaneEventSink, getPaneWebviewContextMap } from '../core/runtime';
import { databaseService } from './database';
import { splitPanelBufferState } from '../database/panelBuffers';
import { panelEventBus } from './panelEventBus';
import { withLock } from '../utils/mutex';
import type { AnalyticsManager } from './analyticsManager';
import type { PaneEventArgument } from '../core/eventSink';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

function logsPanelState(panel: ToolPanel): LogsPanelState {
  // SAFETY: Callers first discriminate `panel.type === 'logs'`; this state is
  // created and persisted by the logs manager as LogsPanelState.
  return panel.state.customState as LogsPanelState;
}

class PanelManager {
  private panels = new Map<string, ToolPanel>();
  // Sessions that have been archived during this process lifetime.
  // Used by getPanel / getPanelsForSession to skip re-caching from DB
  // fallback after cleanupSessionPanelsInMemory has cleared the Map.
  // Without this, a post-archive event (e.g. a PTY exit handler) that
  // calls getPanel(archivedPanelId) would re-populate the cache and
  // silently undo the L3 cleanup.
  private archivedSessionIds = new Set<string>();
  private analyticsManager: AnalyticsManager | null = null;

  setAnalyticsManager(analyticsManager: AnalyticsManager): void {
    this.analyticsManager = analyticsManager;
  }

  private sendRendererEvent(channel: string, ...args: PaneEventArgument[]): void {
    getPaneEventSink().send(channel, ...args);
  }

  constructor() {
    // Clean up restart-only state; other panels are loaded on demand
    this.loadPanelsFromDatabase();
  }
  
  private loadPanelsFromDatabase(): void {
    // This will be called on app startup to restore panel state
    // But we don't start any processes - that happens lazily
    console.log('[PanelManager] Loading panels requiring restart cleanup...');
    
    // Load only panels requiring restart cleanup; terminal state is loaded on demand.
    const startupPanels = databaseService.getPanelsForStartup();
    
    // Clean up any stale running states in logs panels
    startupPanels.forEach(panel => {
      if (panel.type === 'logs' && panel.state?.customState) {
        const logsState = logsPanelState(panel);
        if (logsState.isRunning) {
          // Reset the running state since processes don't survive app restarts
          logsState.isRunning = false;
          // Also clear process-related fields
          logsState.processId = undefined;
          logsState.endTime = new Date().toISOString();
          // Update in database
          databaseService.updatePanel(panel.id, {
            state: panel.state
          });
        }
      }
      // Browser panels used to be created as permanent default tabs. Those
      // legacy defaults (marked permanent, never opened by the user) are
      // dropped; Browser is now an ordinary tool opened from the "+" menu.
      if (panel.type === 'browser' && panel.metadata?.permanent) {
        databaseService.deletePanel(panel.id);
        return;
      }
      // Cache the panel
      this.panels.set(panel.id, panel);
    });
  }
  
  async createPanel(request: CreatePanelRequest): Promise<ToolPanel> {
    return await withLock(`panel-creation-${request.sessionId}`, async () => {
      // When user manually creates a panel, remove it from the closed panel types list
      // This allows auto-creation to work again in the future if they close it again and create a new session
      databaseService.removeClosedPanelType(request.sessionId, request.type);

      const panelId = request.id ?? uuidv4();
      const existingPanel = this.getPanel(panelId);
      if (existingPanel) {
        return existingPanel;
      }
      
      // Auto-generate title if not provided
      const title = request.title || this.generatePanelTitle(request.sessionId, request.type);
      
      // Create initial state
      // Handle both formats: { customState: {...} } and direct panel state {...}
      const providedState = request.initialState;
      const customState = (providedState && 'customState' in providedState)
        ? decodeBoundary(providedState.customState, boundary.jsonObject)
        : providedState ?? {};

      const state: ToolPanelState = {
        isActive: false,
        hasBeenViewed: false,
        customState
      };
      
      // Create metadata (merge with any provided overrides)
      const metadata: ToolPanelMetadata = {
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        position: this.getNextPosition(request.sessionId),
        ...request.metadata // Apply any metadata overrides (like permanent flag)
      };
      
      // Create panel object
      const panel: ToolPanel = {
        id: panelId,
        sessionId: request.sessionId,
        type: request.type,
        title,
        state,
        metadata
      };
      
      const panelRecord = {
        id: panel.id,
        sessionId: panel.sessionId,
        type: panel.type,
        title: panel.title,
        state: panel.state,
        metadata: panel.metadata
      };

      const shouldActivate = request.activate !== false;
      if (shouldActivate) {
        // Save to database and set as active in a single transaction
        databaseService.createPanelAndSetActive(panelRecord);

        // Update the panel state to reflect it's now active
        panel.state.isActive = true;
        panel.metadata.lastActiveAt = new Date().toISOString();
      } else {
        databaseService.createPanel(panelRecord);
      }
      
      // Cache in memory
      this.panels.set(panelId, panel);
      
      if (shouldActivate) {
        // Update panel states to reflect the new active panel
        const panels = this.getPanelsForSession(request.sessionId);
        panels.forEach(p => {
          const isActive = p.id === panelId;
          if (p.state.isActive !== isActive) {
            p.state.isActive = isActive;
            if (isActive) {
              p.metadata.lastActiveAt = new Date().toISOString();
            }
          }
        });
      }
      
      // Emit IPC event to notify frontend
      this.sendRendererEvent('panel:created', panel);

      // Track terminal panel creation analytics (only for new panels, not restoration)
      if (request.type === 'terminal' && this.analyticsManager) {
        const terminalCount = this.getPanelsBySessionAndType(request.sessionId, 'terminal').length;
        this.analyticsManager.track('terminal_panel_created', {
          session_id_hash: this.analyticsManager.hashSessionId(request.sessionId),
          terminal_count: terminalCount
        });
      }

      console.log(`[PanelManager] Created panel ${panelId} of type ${request.type} for session ${request.sessionId}`);

      return panel;
    });
  }
  
  async ensureDiffPanel(sessionId: string): Promise<void> {
    const panels = this.getPanelsForSession(sessionId);
    const hasDiff = panels.some(p => p.type === 'diff');

    if (!hasDiff) {
      console.log(`[PanelManager] Creating diff panel for session ${sessionId}`);
      await this.createPanel({
        sessionId,
        type: 'diff',
        title: 'Diff',
        metadata: { permanent: true }
      });
    }
  }

  async ensureExplorerPanel(sessionId: string): Promise<void> {
    const panels = this.getPanelsForSession(sessionId);
    const hasExplorer = panels.some(p => p.type === 'explorer');

    if (!hasExplorer) {
      console.log(`[PanelManager] Creating explorer panel for session ${sessionId}`);
      await this.createPanel({
        sessionId,
        type: 'explorer',
        title: 'Explorer',
        metadata: { permanent: true }
      });
    }
  }

  async deletePanel(panelId: string): Promise<void> {
    return await withLock(`panel-delete-${panelId}`, async () => {
      const panel = this.getPanel(panelId);
      if (!panel) {
        console.warn(`[PanelManager] Panel ${panelId} not found for deletion`);
        return;
      }

      // Check if panel is permanent
      if (panel.metadata.permanent) {
        console.warn(`[PanelManager] Cannot delete permanent panel ${panelId}`);
        return;
      }

      // Calculate panel lifetime for analytics
      const createdAt = new Date(panel.metadata.createdAt);
      const now = new Date();
      const lifetimeSeconds = Math.floor((now.getTime() - createdAt.getTime()) / 1000);

      // Clean up event subscriptions
      panelEventBus.unsubscribePanel(panelId);

      // If this was the active panel, activate another one
      const activePanelId = databaseService.getActivePanel(panel.sessionId)?.id;
      if (activePanelId === panelId) {
        // Prefer a working tab: Explorer and Review live in the inspector rail,
        // so activating one of those would leave the stage empty.
        const otherPanels = this.getPanelsForSession(panel.sessionId).filter(p => p.id !== panelId);
        const nextPanel = otherPanels.find(p => p.type !== 'explorer' && p.type !== 'diff') ?? otherPanels[0];
        if (nextPanel) {
          await this.setActivePanel(panel.sessionId, nextPanel.id);
        } else {
          await this.setActivePanel(panel.sessionId, null);
        }
      }

      // Track that this panel type was explicitly closed by the user
      // This prevents auto-recreation when the session is reopened
      // Editor tabs are opened per file, so closing one says nothing about
      // wanting the type back.
      if (panel.type !== 'editor') {
        databaseService.addClosedPanelType(panel.sessionId, panel.type);
      }

      // Remove from database
      databaseService.deletePanel(panelId);

      // Remove from cache
      this.panels.delete(panelId);

      // Emit IPC event to notify frontend
      this.sendRendererEvent('panel:deleted', { panelId, sessionId: panel.sessionId });

      // Track panel closure
      if (this.analyticsManager) {
        this.analyticsManager.track('panel_closed', {
          panel_type: panel.type,
          panel_lifetime_seconds: lifetimeSeconds
        });
      }

      console.log(`[PanelManager] Deleted panel ${panelId} and marked ${panel.type} as closed for session`);
    });
  }
  
  async movePanel(panelId: string, sourceId: string, targetId: string): Promise<void> {
    await withLock(`panel-update-${panelId}`, async () => {
      const panel = this.getPanel(panelId);
      if (!panel || panel.sessionId !== sourceId) throw new Error('Chat ownership changed');
      databaseService.movePanel(panelId, sourceId, targetId);
      panel.sessionId = targetId;
      this.sendRendererEvent('panel:deleted', { panelId, sessionId: sourceId });
      this.sendRendererEvent('panel:created', panel);
    });
  }

  async updatePanel(panelId: string, updates: Partial<ToolPanel>): Promise<void> {
    return await withLock(`panel-update-${panelId}`, async () => {
      const panel = this.getPanel(panelId);
      if (!panel) {
        console.warn(`[PanelManager] Panel ${panelId} not found for update`);
        return;
      }
      
      // Update in database. A refused write (state over the ceiling) is
      // already logged there with the panel, size and largest key; the cache
      // and renderer keep the last accepted state.
      const written = databaseService.updatePanel(panelId, {
        title: updates.title,
        state: updates.state,
        metadata: updates.metadata
      });
      if (!written) return;
      
      // Update in cache. Terminal bytes are stored in panel_buffers, so the
      // cached state (and the panel:updated payload) never carries them.
      if (updates.title !== undefined) panel.title = updates.title;
      if (updates.state !== undefined) panel.state = splitPanelBufferState(updates.state).state;
      if (updates.metadata !== undefined) panel.metadata = updates.metadata;
      
      // Emit IPC event to notify frontend
      this.sendRendererEvent('panel:updated', panel);
      
      console.log(`[PanelManager] Updated panel ${panelId}`);
    });
  }
  
  async setActivePanel(sessionId: string, panelId: string | null): Promise<void> {
    return await withLock(`panel-active-${sessionId}`, async () => {
      // Get current active panel for analytics
      const currentActivePanel = databaseService.getActivePanel(sessionId);
      const fromPanelType = currentActivePanel?.type;

      // Update database
      databaseService.setActivePanel(sessionId, panelId);

      // Get new active panel for analytics
      const newActivePanel = panelId ? this.getPanel(panelId) : null;
      const toPanelType = newActivePanel?.type;

      // Update panel states
      const panels = this.getPanelsForSession(sessionId);
      panels.forEach(panel => {
        const isActive = panel.id === panelId;
        if (panel.state.isActive !== isActive) {
          panel.state.isActive = isActive;
          if (isActive) {
            panel.metadata.lastActiveAt = new Date().toISOString();
          }
          // Don't call updatePanel here to avoid nested locks
          // Update in database directly
          databaseService.updatePanel(panel.id, {
            state: panel.state,
            metadata: panel.metadata
          });

          // Update in cache
          this.panels.set(panel.id, panel);
        }
      });

      // Emit IPC event to notify frontend
      this.sendRendererEvent('panel:activeChanged', { sessionId, panelId });

      // Track panel switching (only if both from and to panels exist)
      if (this.analyticsManager && fromPanelType && toPanelType && fromPanelType !== toPanelType) {
        this.analyticsManager.track('panel_switched', {
          from_panel_type: fromPanelType,
          to_panel_type: toPanelType
        });
      }

      console.log(`[PanelManager] Set active panel for session ${sessionId} to ${panelId}`);
    });
  }
  
  getPanel(panelId: string): ToolPanel | undefined {
    // Check cache first
    if (this.panels.has(panelId)) {
      return this.panels.get(panelId);
    }

    // Load from database if not cached
    const panel = databaseService.getPanel(panelId);
    if (panel) {
      // Skip caching if this panel belongs to a session we've already
      // archived in this process. Prevents a post-archive event from
      // resurrecting the cache entry and undoing L3 cleanup.
      if (!this.archivedSessionIds.has(panel.sessionId)) {
        this.panels.set(panelId, panel);
      }
      return panel;
    }

    return undefined;
  }
  
  getPanelsForSession(sessionId: string): ToolPanel[] {
    // Always get fresh from database to ensure consistency
    const panels = databaseService.getPanelsForSession(sessionId);
    // If this session has been archived in this process, we still
    // return the panels (callers like the sessions:delete PTY-destroy
    // loop need them) but we do NOT re-populate this.panels — doing so
    // would undo the L3 cleanup that cleared them moments earlier.
    const shouldCache = !this.archivedSessionIds.has(sessionId);

    if (shouldCache) {
      for (const panel of panels) {
        this.panels.set(panel.id, panel);
      }
    }

    return panels;
  }
  
  getPanelsBySessionAndType(sessionId: string, type: ToolPanelType): ToolPanel[] {
    const panels = this.getPanelsForSession(sessionId);
    return panels.filter(p => p.type === type);
  }
  
  async emitPanelEvent(panelId: string, eventType: PanelEventType, data: PaneEventArgument): Promise<void> {
    const panel = this.getPanel(panelId);
    if (!panel) {
      console.warn(`[PanelManager] Panel ${panelId} not found for event emission`);
      return;
    }
    
    const event = {
      type: eventType,
      source: {
        panelId: panel.id,
        panelType: panel.type,
        sessionId: panel.sessionId
      },
      data,
      timestamp: new Date().toISOString()
    };
    
    // Emit through event bus
    panelEventBus.emitPanelEvent(event);
    
    // Also emit to frontend via IPC
    this.sendRendererEvent('panel:event', event);
  }
  
  private generatePanelTitle(sessionId: string, type: string): string {
    const existingPanels = this.getPanelsForSession(sessionId);
    const samePType = existingPanels.filter(p => p.type === type);
    const nextNumber = samePType.length + 1;
    
    // Capitalize first letter of type
    const capitalizedType = type.charAt(0).toUpperCase() + type.slice(1);
    
    return `${capitalizedType} ${nextNumber}`;
  }
  
  private getNextPosition(sessionId: string): number {
    const panels = this.getPanelsForSession(sessionId);
    if (panels.length === 0) return 0;
    
    const maxPosition = Math.max(...panels.map(p => p.metadata.position));
    return maxPosition + 1;
  }
  
  // Clean up all panels for a session (called when session is deleted)
  async cleanupSessionPanels(sessionId: string): Promise<void> {
    const panels = this.getPanelsForSession(sessionId);

    for (const panel of panels) {
      // Unsubscribe from events
      panelEventBus.unsubscribePanel(panel.id);

      // Remove from cache
      this.panels.delete(panel.id);
    }

    // Delete all from database (cascade delete should handle this too)
    databaseService.deletePanelsForSession(sessionId);

    console.log(`[PanelManager] Cleaned up ${panels.length} panels for session ${sessionId}`);
  }

  /**
   * Archive-safe cleanup. Clears in-memory state and unsubscribes
   * panelEventBus. Does NOT hard-delete DB rows (archive keeps DB rows alive).
   * Also sweeps webviewContextMap for any entries owned by this session.
   */
  async cleanupSessionPanelsInMemory(sessionId: string): Promise<void> {
    // 1. Mark this session as archived FIRST, so that any subsequent
    //    getPanel / getPanelsForSession call (including our own
    //    resolution on the next line, and any late-arriving PTY exit
    //    or output handler after archive) will NOT re-populate
    //    this.panels from the DB fallback path.
    this.archivedSessionIds.add(sessionId);

    // 2. Resolve panels for this session. With the marker set above,
    //    getPanelsForSession will return fresh rows from the DB but
    //    will not cache them.
    const panelsForSession = this.getPanelsForSession(sessionId);

    // 3. Unsubscribe panelEventBus for each panel.
    for (const panel of panelsForSession) {
      try {
        panelEventBus.unsubscribePanel(panel.id);
      } catch (err) {
        console.error(`[PanelManager] unsubscribePanel failed for ${panel.id}`, err);
      }
    }

    // 4. Drop any in-memory panels Map entries that survived from
    //    before the archive (e.g. created while the session was
    //    active). Keyed by panel.id, not sessionId.
    for (const panel of panelsForSession) {
      this.panels.delete(panel.id);
    }

    // 5. Sweep webviewContextMap for entries owned by this session.
    const webviewContextMap = getPaneWebviewContextMap();
    for (const [wcId, ctx] of webviewContextMap.entries()) {
      if (ctx.sessionId === sessionId) {
        webviewContextMap.delete(wcId);
      }
    }

    console.log(`[PanelManager] In-memory cleanup for ${panelsForSession.length} panels of session ${sessionId}`);
  }

  /**
   * Check if a panel type should be auto-created for a session
   * Returns false if:
   * - A panel of that type already exists for the session
   * - The user has previously closed a panel of that type for this session
   */
  shouldAutoCreatePanel(sessionId: string, panelType: string): boolean {
    // Check if panel already exists
    const existingPanels = this.getPanelsForSession(sessionId);
    if (existingPanels.some(p => p.type === panelType)) {
      return false;
    }

    // Check if user has explicitly closed this panel type
    if (databaseService.isPanelTypeClosed(sessionId, panelType)) {
      console.log(`[PanelManager] Skipping auto-create of ${panelType} panel for session ${sessionId} - user previously closed it`);
      return false;
    }

    return true;
  }
}

// Export singleton instance
export const panelManager = new PanelManager();
