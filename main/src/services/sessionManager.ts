/**
 * Session management for Pane.
 * Note: "Sessions" are called "Panes" in the UI. Internally they remain
 * "sessions" in code, database, and IPC to avoid a massive refactor.
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import type { Session, SessionUpdate, SessionOutput } from '../types/session';
import type { DatabaseService } from '../database/database';
import type { Session as DbSession, CreateSessionData, UpdateSessionData, ConversationMessage, PromptMarker, ExecutionDiff, CreateExecutionDiffData, Project } from '../database/models';
import { TerminalSessionManager } from './terminalSessionManager';
import type { ToolPanelState, ResumableSession } from '../../../shared/types/panels';
import { formatForDisplay } from '../utils/timestampUtils';
import { isCliAgentType, resolveAgentTypeFromCommand } from './agents/agentIdentity';
import { resolveResumeId } from './agents/agentResume';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

interface CreateSessionOptions {
  detached?: boolean;
  hidden?: boolean;
  worktreeOwnership?: 'pane' | 'external';
}

interface ProjectContext {
  project: Project;
  pathResolver: PathResolver;
  commandRunner: CommandRunner;
}

interface CommandExecutionError {
  stderr?: string;
  stdout?: string;
  message?: string;
}

// Interface for generic JSON message data that can contain various properties
interface MessageTextBlock { type: string; text?: string }
interface GenericMessageData {
  type?: string;
  subtype?: string;
  session_id?: string;
  message_id?: string;
  message?: string | { content?: string | MessageTextBlock[] };
  data?: { status?: string; message?: JsonValue };
  delta?: string;
}

const genericMessageSchema = boundary.object({
  type: boundary.optional(boundary.string),
  subtype: boundary.optional(boundary.string),
  session_id: boundary.optional(boundary.string),
  message_id: boundary.optional(boundary.string),
  message: boundary.optional(boundary.union(
    boundary.string,
    boundary.object({
      content: boundary.optional(boundary.union(
        boundary.string,
        boundary.array(boundary.object({
          type: boundary.string,
          text: boundary.optional(boundary.string),
        })),
      )),
    }),
  )),
  data: boundary.optional(boundary.object({
    status: boundary.optional(boundary.string),
    message: boundary.optional(boundary.json),
  })),
  delta: boundary.optional(boundary.string),
});

function parseGenericMessage(output: Omit<SessionOutput, 'sessionId'>): GenericMessageData | undefined {
  if (output.type !== 'json') return undefined;
  try {
    return decodeBoundary(output.data, genericMessageSchema);
  } catch {
    return undefined;
  }
}

function getMessageContent(message: GenericMessageData['message']): string | MessageTextBlock[] | undefined {
  if (message === undefined) return undefined;
  try {
    return decodeBoundary(message, boundary.object({
      content: boundary.optional(boundary.union(
        boundary.string,
        boundary.array(boundary.object({ type: boundary.string, text: boundary.optional(boundary.string) })),
      )),
    })).content;
  } catch {
    return undefined;
  }
}

const terminalResumeStateSchema = boundary.object({
  wasInterrupted: boundary.optional(boundary.boolean),
  initialCommand: boundary.optional(boundary.string),
  agentType: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
  agentSessionId: boundary.optional(boundary.string),
  hasClaudeSessionId: boundary.optional(boundary.boolean),
});

function parseTerminalResumeState(value: ToolPanelState['customState']): {
  wasInterrupted?: boolean;
  initialCommand?: string;
  agentType?: 'claude' | 'codex' | 'cursor';
  agentSessionId?: string;
  hasClaudeSessionId?: boolean;
} | undefined {
  try {
    return decodeBoundary(value, terminalResumeStateSchema);
  } catch {
    return undefined;
  }
}

function normalizeDbOutputType(type: DbSessionOutputType): SessionOutput['type'] {
  return type === 'system' ? 'stdout' : type;
}

type DbSessionOutputType = import('../database/models').SessionOutput['type'];

// Interface for panel state with custom state that can hold any AI-specific data
import { addSessionLog } from '../ipc/logs';
import { PathResolver } from '../utils/pathResolver';
import { CommandRunner } from '../utils/commandRunner';
import { withLock } from '../utils/mutex';
import { detectGitBase } from './worktreeManager';
import { panelManager } from './panelManager';
import type { AnalyticsManager } from './analyticsManager';

export class SessionManager extends EventEmitter {
  private activeSessions: Map<string, Session> = new Map();
  private activeProject: Project | null = null;
  private terminalSessionManager: TerminalSessionManager;
  private autoContextBuffers: Map<string, SessionOutput[]> = new Map();
  private analyticsManager: AnalyticsManager | null = null;
  private projectContextCache = new Map<number, { pathResolver: PathResolver; commandRunner: CommandRunner }>();

  constructor(public db: DatabaseService, analyticsManager?: AnalyticsManager) {
    super();
    // Increase max listeners to prevent warnings when many components listen to events
    // This is expected since multiple SessionListItem components and project tree views listen to events
    this.setMaxListeners(100);
    this.analyticsManager = analyticsManager || null;
    this.terminalSessionManager = new TerminalSessionManager();
    
    // Forward terminal output events to the terminal display
    this.terminalSessionManager.on('terminal-output', ({ sessionId, data, type }) => {
      // Terminal PTY output goes directly to the terminal view
      // Terminal is now independent and not used for run scripts
      this.emit('terminal-output', { sessionId, data, type });
    });
    
    // Forward zombie process detection events
    this.terminalSessionManager.on('zombie-processes-detected', (data) => {
      this.emit('zombie-processes-detected', data);
    });
  }

  setActiveProject(project: Project): void {
    this.activeProject = project;
    this.emit('active-project-changed', project);
  }

  getActiveProject(): Project | null {
    if (!this.activeProject) {
      this.activeProject = this.db.getActiveProject() || null;
      if (this.activeProject) {
        // Active project loaded successfully
      }
    }
    return this.activeProject;
  }

  getDbSession(id: string): DbSession | undefined {
    return this.db.getSession(id);
  }
  
  getClaudeSessionId(id: string): string | undefined {
    const dbSession = this.db.getSession(id);
    const claudeSessionId = dbSession?.claude_session_id;
    return claudeSessionId;
  }

  beginAutoContextCapture(panelId: string): void {
    // Use synchronous operation - no race condition here as it's a simple set
    this.autoContextBuffers.set(panelId, []);
  }

  collectAutoContextOutput(panelId: string, output: SessionOutput): void {
    // Get buffer atomically - if it doesn't exist, skip collection
    // This prevents race with consumeAutoContextCapture
    const buffer = this.autoContextBuffers.get(panelId);
    if (buffer) {
      buffer.push(output);
    }
  }

  consumeAutoContextCapture(panelId: string): SessionOutput[] {
    // Atomically get and delete the buffer to prevent races with collectAutoContextOutput
    const buffer = this.autoContextBuffers.get(panelId) ?? [];
    this.autoContextBuffers.delete(panelId);
    // Return a copy to prevent external modifications to our internal state
    return [...buffer];
  }

  clearAutoContextCapture(panelId: string): void {
    this.autoContextBuffers.delete(panelId);
  }

  hasAutoContextCapture(panelId: string): boolean {
    return this.autoContextBuffers.has(panelId);
  }
  
  // Generic method for getting agent session ID (works for any AI panel)
  getPanelAgentSessionId(panelId: string): string | undefined {
    try {
      const panel = this.db.getPanel(panelId);
      const customState = parseTerminalResumeState(panel?.state?.customState);
      return customState?.agentSessionId;
    } catch {
      return undefined;
    }
  }

  getProjectById(id: number): Project | undefined {
    return this.db.getProject(id);
  }

  getProjectForSession(sessionId: string): Project | undefined {
    const dbSession = this.getDbSession(sessionId);
    if (dbSession?.project_id) {
      return this.getProjectById(dbSession.project_id);
    }
    return undefined;
  }

  getProjectContext(sessionId: string): { project: Project; pathResolver: PathResolver; commandRunner: CommandRunner } | null {
    const project = this.getProjectForSession(sessionId);
    if (!project) return null;
    return this.getOrCreateContext(project);
  }

  getProjectContextByProjectId(projectId: number): { project: Project; pathResolver: PathResolver; commandRunner: CommandRunner } | null {
    const project = this.getProjectById(projectId);
    if (!project) return null;
    return this.getOrCreateContext(project);
  }

  invalidateProjectContext(projectId: number): void {
    this.projectContextCache.delete(projectId);
  }

  private getOrCreateContext(project: Project): ProjectContext {
    if (!this.projectContextCache.has(project.id)) {
      this.projectContextCache.set(project.id, {
        pathResolver: new PathResolver(project),
        commandRunner: new CommandRunner(project),
      });
    }
    const cached = this.projectContextCache.get(project.id)!;
    return { project, ...cached };
  }

  initializeFromDatabase(): void {
    // Hidden sessions are included for crash recovery, but not emitted to the
    // normal renderer session list.
    const dbSessions = this.db.getAllSessions(undefined, { includeHidden: true });
    const visibleDbSessions = dbSessions.filter(s => !s.is_hidden);

    // Partition sessions by status
    const activeSessions = dbSessions.filter(s => s.status === 'running' || s.status === 'pending');
    const interruptedSessions = dbSessions.filter(s => s.status === 'interrupted');

    // Mark crashed sessions (running/pending) as stopped (crash recovery)
    if (activeSessions.length > 0) {
      const activeIds = activeSessions.map(s => s.id);
      this.db.markSessionsAsStopped(activeIds);
      console.log(`[SessionManager] Marked ${activeIds.length} crashed session(s) as stopped`);
    }

    // Log interrupted sessions (these will be handled by resume dialog)
    if (interruptedSessions.length > 0) {
      console.log(`[SessionManager] Found ${interruptedSessions.length} interrupted session(s) available for resume`);
    }

    // Load all sessions from database
    this.emit('sessions-loaded', visibleDbSessions.map(this.convertDbSessionToSession.bind(this)));
  }

  private convertDbSessionToSession(dbSession: DbSession): Session {
    const toolTypeFromDb = dbSession.tool_type;
    const normalizedToolType: 'claude' | 'none' = toolTypeFromDb === 'none'
        ? 'none'
        : 'claude';

    return {
      id: dbSession.id,
      name: dbSession.name,
      worktreePath: dbSession.worktree_path,
      prompt: dbSession.initial_prompt,
      status: this.mapDbStatusToSessionStatus(dbSession.status),
      statusMessage: dbSession.worktree_ownership === 'external' && !existsSync(dbSession.worktree_path)
        ? 'External worktree directory is missing'
        : dbSession.status_message,
      pid: dbSession.pid,
      createdAt: new Date(dbSession.created_at),
      lastActivity: new Date(dbSession.updated_at),
      output: [], // Will be loaded separately by frontend when needed
      jsonMessages: [], // Will be loaded separately by frontend when needed
      error: dbSession.exit_code && dbSession.exit_code !== 0 ? `Exit code: ${dbSession.exit_code}` : undefined,
      isRunning: false,
      lastViewedAt: dbSession.last_viewed_at,
      permissionMode: dbSession.permission_mode,
      runStartedAt: dbSession.run_started_at,
      isMainRepo: dbSession.is_main_repo,
      worktreeOwnership: dbSession.worktree_ownership ?? 'pane',
      projectId: dbSession.project_id ?? undefined,
      folderId: dbSession.folder_id,
      displayOrder: dbSession.display_order, // Include displayOrder for proper sorting
      isFavorite: dbSession.is_favorite,
      favoritePinnedAt: dbSession.favorite_pinned_at ?? undefined,
      // Model is now managed at panel level
      toolType: normalizedToolType,
      archived: dbSession.archived || false,
      isHidden: !!dbSession.is_hidden,
      baseCommit: dbSession.base_commit,
      baseBranch: dbSession.base_branch,
      pr_renamed: !!dbSession.pr_renamed
    };
  }

  private mapDbStatusToSessionStatus(dbStatus: string): Session['status'] {
    switch (dbStatus) {
      case 'pending': return 'initializing';
      case 'running': return 'running';
      case 'interrupted': return 'stopped'; // Map interrupted to stopped for frontend display (resume dialog handles these separately)
      case 'stopped':
      case 'completed': return 'stopped';
      case 'failed': return 'error';
      default: return 'stopped';
    }
  }

  private mapSessionStatusToDbStatus(status: Session['status']): DbSession['status'] {
    switch (status) {
      case 'initializing': return 'pending';
      case 'ready': return 'running';
      case 'running': return 'running';
      case 'waiting': return 'running';
      case 'stopped': return 'stopped';
      case 'error': return 'failed';
      default: return 'stopped';
    }
  }

  getAllSessions(): Session[] {
    // Return all sessions regardless of active project
    const dbSessions = this.db.getAllSessions();
    return dbSessions.map(this.convertDbSessionToSession.bind(this));
  }

  getPowerSaveSnapshotSessions(): Session[] {
    const dbSessions = this.db.getPowerSaveSnapshotSessions();
    return dbSessions.map(this.convertDbSessionToSession.bind(this));
  }

  getSessionsForProject(projectId: number): Session[] {
    const dbSessions = this.db.getAllSessions(projectId);
    return dbSessions.map(this.convertDbSessionToSession.bind(this));
  }

  getSession(id: string): Session | undefined {
    const dbSession = this.db.getSession(id);
    return dbSession ? this.convertDbSessionToSession(dbSession) : undefined;
  }

  async createSession(
    name: string,
    worktreePath: string,
    prompt: string,
    worktreeName: string,
    permissionMode?: 'approve' | 'ignore',
    projectId?: number,
    isMainRepo?: boolean,
    folderId?: string,
    toolType?: 'claude' | 'none',
    baseCommit?: string,
    baseBranch?: string,
    startPinned?: boolean,
    options?: CreateSessionOptions
  ): Promise<Session> {
    return await withLock(`session-creation`, async () => {
      return this.createSessionWithId(
        randomUUID(),
        name,
        worktreePath,
        prompt,
        worktreeName,
        permissionMode,
        projectId,
        isMainRepo,
        folderId,
        toolType,
        baseCommit,
        baseBranch,
        startPinned,
        options
      );
    });
  }

  createSessionWithId(
    id: string,
    name: string,
    worktreePath: string,
    prompt: string,
    worktreeName: string,
    permissionMode?: 'approve' | 'ignore',
    projectId?: number,
    isMainRepo?: boolean,
    folderId?: string,
    toolType?: 'claude' | 'none',
    baseCommit?: string,
    baseBranch?: string,
    startPinned?: boolean,
    options?: CreateSessionOptions
  ): Session {
    // Ensure this session ID isn't already being created
    if (this.activeSessions.has(id) || this.db.getSession(id)) {
      throw new Error(`Session with ID ${id} already exists`);
    }
    
    // Add log entry for session creation
    addSessionLog(id, 'info', `Creating session: ${name}`, 'SessionManager');
    
    let targetProject: Project | null = null;
    const isDetached = options?.detached === true;
    
    if (isDetached) {
      targetProject = null;
    } else if (projectId) {
      targetProject = this.getProjectById(projectId) ?? null;
      if (!targetProject) {
        throw new Error(`Project with ID ${projectId} not found`);
      }
    } else {
      // Fall back to active project for backward compatibility
      targetProject = this.getActiveProject();
      if (!targetProject) {
        throw new Error('No project specified and no active project selected');
      }
    }

    const sessionData: CreateSessionData = {
      id,
      name,
      initial_prompt: prompt || '', // Use empty string if prompt is undefined/null
      worktree_name: worktreeName,
      worktree_path: worktreePath,
      project_id: targetProject?.id ?? null,
      folder_id: folderId,
      permission_mode: permissionMode,
      is_main_repo: isMainRepo,
      worktree_ownership: options?.worktreeOwnership ?? 'pane',
      commit_mode: options?.worktreeOwnership === 'external' ? 'disabled' : undefined,
      // Model is now managed at panel level
      base_commit: baseCommit,
      base_branch: baseBranch,
      tool_type: toolType,
      is_favorite: startPinned,
      favorite_pinned_at: startPinned ? 'CURRENT_TIMESTAMP' : undefined,
      is_hidden: options?.hidden === true
    };

    const dbSession = this.db.createSession(sessionData);
    
    const session = this.convertDbSessionToSession(dbSession);
    session.toolType = toolType || session.toolType;
    
    this.activeSessions.set(session.id, session);
    // Don't emit the event here - let the caller decide when to emit it
    // this.emit('session-created', session);

    // Track session creation with analytics
    if (this.analyticsManager && !options?.hidden) {
      // Get session statistics for analytics
      const allSessions = this.db.getAllSessions();
      const activeSessions = allSessions.filter(s => !s.archived);
      const archivedSessions = allSessions.filter(s => s.archived);

      // Count sessions by status
      const statusCounts: Record<string, number> = {};
      activeSessions.forEach(s => {
        const status = s.status || 'unknown';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });

      // Count unique projects
      const allProjects = this.db.getAllProjects();
      const projectCount = allProjects.length;

      this.analyticsManager.track('session_created', {
        tool_type: toolType || 'none',
        template_type: worktreeName.startsWith('main') ? 'main' : 'worktree',
        session_count: 1, // This is for a single session creation
        has_folder: !!folderId,
        used_claude_code: toolType === 'claude',
        used_auto_name: false, // Will be updated by caller if auto-name was used
        auto_name_available: true, // Auto-naming is always available
        git_mode: isMainRepo ? 'main_repo' : 'disabled',
        existing_active_sessions_count: activeSessions.length,
        existing_total_sessions_count: allSessions.length,
        existing_archived_sessions_count: archivedSessions.length,
        existing_sessions_initializing: statusCounts['initializing'] || 0,
        existing_sessions_running: statusCounts['running'] || 0,
        existing_sessions_stopped: statusCounts['stopped'] || 0,
        existing_sessions_error: statusCounts['error'] || 0,
        existing_projects_count: projectCount
      });
    }

    return session;
  }

  async getOrCreateMainRepoSession(projectId: number): Promise<Session> {
    return await withLock(`main-repo-session-${projectId}`, async () => {
      // First check if a main repo session already exists
      const existingSession = this.db.getMainRepoSession(projectId);
      if (existingSession) {
        const session = this.convertDbSessionToSession(existingSession);
        await panelManager.ensureExplorerPanel(session.id);
        await panelManager.ensureDiffPanel(session.id);
        return session;
      }
      
      // Get the project
      const project = this.getProjectById(projectId);
      if (!project) {
        throw new Error(`Project with ID ${projectId} not found`);
      }
      

      // Create a new main repo session
      const sessionId = randomUUID();
      const sessionName = `${project.name} (Main)`;
      const worktreePath = project.path; // Use the project path directly
      const worktreeName = 'main'; // Use 'main' as the worktree name
      const prompt = ''; // Empty prompt - user hasn't sent anything yet

      // Detect baseBranch and baseCommit from git
      const { commandRunner } = this.getOrCreateContext(project);
      const { baseBranch, baseCommit } = await detectGitBase(project.path, commandRunner);

      const session = this.createSessionWithId(
        sessionId,
        sessionName,
        worktreePath,
        prompt,
        worktreeName,
        project.default_permission_mode || 'ignore', // Default to 'ignore' if not set
        projectId,
        true, // isMainRepo = true
        undefined, // folderId
        'claude', // tool_type
        baseCommit,
        baseBranch
      );
      
      await panelManager.ensureExplorerPanel(session.id);
      await panelManager.ensureDiffPanel(session.id);
      // Explorer is the intended initial tab (the diff creation above just
      // stole active by being the last createPanel).
      const explorerPanel = panelManager
        .getPanelsForSession(session.id)
        .find((p) => p.type === 'explorer');
      if (explorerPanel) {
        await panelManager.setActivePanel(session.id, explorerPanel.id);
      }
      return session;
    });
  }

  emitSessionCreated(
    session: Session,
    options: { activateOnCreate?: boolean; createDefaultTerminalOnCreate?: boolean } = {},
  ): void {
    this.emit('session-created', {
      ...session,
      activateOnCreate: options.activateOnCreate !== false,
      createDefaultTerminalOnCreate: options.createDefaultTerminalOnCreate !== false,
    });
  }

  updateSession(id: string, update: SessionUpdate): void {

    // Add log entry for important status changes
    if (update.status) {
      addSessionLog(id, 'info', `Session status changed to: ${update.status}`, 'SessionManager');
    }
    if (update.statusMessage) {
      addSessionLog(id, 'info', `Status: ${update.statusMessage}`, 'SessionManager');
    }
    if (update.error) {
      addSessionLog(id, 'error', `Session error: ${update.error}`, 'SessionManager');
    }

    const dbUpdate: UpdateSessionData = {};

    if (update.status !== undefined) {
      dbUpdate.status = this.mapSessionStatusToDbStatus(update.status);
    }

    if (update.statusMessage !== undefined) {
      dbUpdate.status_message = update.statusMessage;
    }

    // Model is now managed at panel level, not session level

    if (update.skip_continue_next !== undefined) {
      dbUpdate.skip_continue_next = update.skip_continue_next;
    }

    const updatedDbSession = this.db.updateSession(id, dbUpdate);
    if (!updatedDbSession) {
      console.error(`[SessionManager] Session ${id} not found in database`);
      throw new Error(`Session ${id} not found`);
    }

    const session = this.convertDbSessionToSession(updatedDbSession);

    // Apply any additional updates not stored in DB
    Object.assign(session, update);

    this.activeSessions.set(id, session);
    this.emit('session-updated', session);
  }

  updateSessionStatus(id: string, status: Session['status'], statusMessage?: string): void {
    this.updateSession(id, { status, statusMessage });

    // Track session start when status changes to running
    if (status === 'running' && this.analyticsManager) {
      const session = this.getSession(id);
      if (session) {
        // Check if this is a continuation based on conversation history
        const conversationMessages = this.getConversationMessages(id);
        const isContinuation = conversationMessages.length > 0;

        this.analyticsManager.track('session_started', {
          tool_type: session.toolType || 'none',
          is_continuation: isContinuation
        });
      }
    }
  }

  addSessionError(id: string, error: string, details?: string): void {
    const errorData = {
      error: error,
      details: details,
      timestamp: new Date().toISOString()
    };
    
    this.addSessionOutput(id, {
      type: 'error',
      data: errorData,
      timestamp: new Date()
    });
    
    // Mark the session as having an error
    this.updateSession(id, { status: 'error', error: error });
  }


  addSessionOutput(id: string, output: Omit<SessionOutput, 'sessionId'>): void {
    const message = parseGenericMessage(output);
    const messageContent = getMessageContent(message?.message);
    // Store in database (stringify JSON objects and error objects)
    const dataToStore = (output.type === 'json' || output.type === 'error') ? JSON.stringify(output.data) : String(output.data);
    this.db.addSessionOutput(id, output.type, dataToStore);
    
    // Emit the output so it shows immediately in the UI
    const outputToEmit: SessionOutput = {
      sessionId: id,
      ...output
    };
    this.emit('session-output', outputToEmit);
    
    // Emit output-available event to notify frontend that new output is available
    // This is used to trigger output panel refresh when new content is added (e.g., after git operations)
    this.emit('session-output-available', { sessionId: id });
    
    // Check if this is the initial system message with Claude's session ID
    if (message?.type === 'system' && message.subtype === 'init' && message.session_id) {
      // Store Claude's actual session ID
      this.db.updateSession(id, { claude_session_id: message.session_id });
    }
    
    // Check if this is a system result message — update the completion timestamp for the most recent prompt
    if (message?.type === 'system' && message.subtype === 'result') {
      const completionTimestamp = output.timestamp instanceof Date ? output.timestamp.toISOString() : output.timestamp;
      this.db.updatePromptMarkerCompletion(id, completionTimestamp);
    }
    
    // Check if this is a user message in JSON format to track prompts
    if (message?.type === 'user' && messageContent) {
      // Extract text content from user messages
      const content = messageContent;
      let promptText = '';
      
      if (Array.isArray(content)) {
        // Look for text content in the array
        const textContent = content.find((item: { type: string; text?: string }) => item.type === 'text');
        if (textContent?.text) {
          promptText = textContent.text;
        }
      } else {
        promptText = content;
      }
      
      if (promptText) {
        // Get current output count to use as index
        const outputCount = this.db.getSessionOutputCount(id);
        this.db.addPromptMarker(id, promptText, outputCount - 1);
        // Also add to conversation messages for continuation support
        this.db.addConversationMessage(id, 'user', promptText);
      }
    }
    
    // Check if this is an assistant message to track for conversation history
    if (message?.type === 'assistant' && messageContent) {
      // Extract text content from assistant messages
      const content = messageContent;
      let assistantText = '';
      
      if (Array.isArray(content)) {
        // Concatenate all text content from the array
        assistantText = content
          .filter((item: { type: string; text?: string }) => item.type === 'text')
          .map((item: { type: string; text?: string }) => item.text || '')
          .join('\n');
      } else {
        assistantText = content;
      }
      
      if (assistantText) {
        // Add to conversation messages for continuation support
        this.db.addConversationMessage(id, 'assistant', assistantText);
      }
    }
    
    // Update in-memory session
    const session = this.activeSessions.get(id);
    if (session) {
      if (output.type === 'json') {
        session.jsonMessages.push(output.data);
      } else {
        session.output.push(String(output.data));
      }
      session.lastActivity = new Date();
    }
    
    const fullOutput: SessionOutput = {
      sessionId: id,
      ...output
    };
    
    this.emit('session-output', fullOutput);
  }

  getSessionOutput(id: string, limit?: number): SessionOutput[] {
    return this.getSessionOutputs(id, limit);
  }

  getSessionOutputs(id: string, limit?: number): SessionOutput[] {
    const dbOutputs = this.db.getSessionOutputs(id, limit);
    return dbOutputs.map(dbOutput => ({
      sessionId: dbOutput.session_id,
      type: normalizeDbOutputType(dbOutput.type),
      data: (dbOutput.type === 'json' || dbOutput.type === 'error') ? JSON.parse(dbOutput.data) : dbOutput.data,
      timestamp: new Date(dbOutput.timestamp)
    }));
  }

  getSessionOutputsForPanel(panelId: string, limit?: number): SessionOutput[] {
    const dbOutputs = this.db.getSessionOutputsForPanel(panelId, limit);
    return dbOutputs.map(dbOutput => ({
      sessionId: dbOutput.session_id,
      panelId: dbOutput.panel_id,
      type: normalizeDbOutputType(dbOutput.type),
      data: (dbOutput.type === 'json' || dbOutput.type === 'error') ? JSON.parse(dbOutput.data) : dbOutput.data,
      timestamp: new Date(dbOutput.timestamp)
    }));
  }

  async archiveSession(id: string): Promise<void> {
    // Track session archival with analytics before archiving
    if (this.analyticsManager) {
      const dbSession = this.db.getSession(id);
      if (dbSession) {
        // Calculate session age in days
        const createdTime = new Date(dbSession.created_at).getTime();
        const currentTime = Date.now();
        const sessionAgeDays = Math.floor((currentTime - createdTime) / (1000 * 60 * 60 * 24));

        this.analyticsManager.track('session_archived', {
          session_age_days: sessionAgeDays
        });
      }
    }

    const success = this.db.archiveSession(id);
    if (!success) {
      throw new Error(`Session ${id} not found`);
    }

    // Close terminal session if it exists
    await this.terminalSessionManager.closeTerminalSession(id);
    
    this.activeSessions.delete(id);
    this.emit('session-deleted', { id }); // Keep the same event name for frontend compatibility
  }

  stopSession(id: string): void {
    // Track session stop with analytics
    if (this.analyticsManager) {
      const session = this.getSession(id);
      if (session) {
        const dbSession = this.db.getSession(id);

        // Calculate duration
        let durationSeconds = 0;
        if (dbSession?.run_started_at) {
          const startTime = new Date(dbSession.run_started_at).getTime();
          const endTime = Date.now();
          durationSeconds = Math.floor((endTime - startTime) / 1000);
        }

        // Check if session had errors
        const hadErrors = !!session.error || dbSession?.exit_code !== 0;

        this.analyticsManager.track('session_stopped', {
          duration_seconds: durationSeconds,
          duration_category: this.analyticsManager.categorizeDuration(durationSeconds),
          had_errors: hadErrors
        });
      }
    }

    this.updateSession(id, { status: 'stopped' });
  }

  setSessionPid(id: string, pid: number): void {
    this.db.updateSession(id, { pid });
    const session = this.activeSessions.get(id);
    if (session) {
      session.pid = pid;
    }
  }

  setSessionExitCode(id: string, exitCode: number): void {
    this.db.updateSession(id, { exit_code: exitCode });
  }

  addConversationMessage(id: string, messageType: 'user' | 'assistant', content: string): void {
    this.db.addConversationMessage(id, messageType, content);
  }

  getConversationMessages(id: string): ConversationMessage[] {
    return this.db.getConversationMessages(id);
  }

  getConversationMessageCount(sessionId: string): number {
    return this.db.getConversationMessageCount(sessionId);
  }

  // Panel-based methods for Claude panels (use panel_id instead of session_id)
  addPanelOutput(panelId: string, output: Omit<SessionOutput, 'sessionId'>): void {
    const message = parseGenericMessage(output);
    const messageContent = getMessageContent(message?.message);
    const panel = this.db.getPanel(panelId);

    if (this.hasAutoContextCapture(panelId)) {
      const bufferedOutput: SessionOutput = {
        sessionId: panel?.sessionId || '',
        panelId,
        type: output.type,
        data: output.data,
        timestamp: output.timestamp instanceof Date ? output.timestamp : new Date(output.timestamp)
      };
      this.collectAutoContextOutput(panelId, bufferedOutput);
      return;
    }

    const dataToStore = (output.type === 'json' || output.type === 'error') 
      ? JSON.stringify(output.data) 
      : String(output.data);
    
    this.db.addPanelOutput(panelId, output.type, dataToStore);

    // Capture Claude's session ID from init/system messages for proper --resume handling
    try {
      if (message) {
        const sessionIdFromMsg = (message.type === 'system' && message.subtype === 'init' && message.session_id) || message.session_id;
        if (sessionIdFromMsg && panel?.sessionId) {
          this.db.updateSession(panel.sessionId, { claude_session_id: sessionIdFromMsg });
        }
      }
    } catch (e) {
      console.warn('[SessionManager] Failed to capture Claude session_id from panel output:', e);
    }

    // Check if this is a system result message indicating panel execution has completed
    if (message?.type === 'system' && message.subtype === 'result') {
      // Update the completion timestamp for the most recent prompt marker for this panel
      const completionTimestamp = output.timestamp instanceof Date ? output.timestamp.toISOString() : output.timestamp;
      this.db.updatePanelPromptMarkerCompletion(panelId, completionTimestamp);
    }

    // Handle assistant conversation message extraction for Claude panels (same logic as sessions)
    if (message?.type === 'assistant' && messageContent) {
      // Extract text content from assistant messages
      const content = messageContent;
      let assistantText = '';

      if (Array.isArray(content)) {
        // Concatenate all text content from the array
        assistantText = content
          .filter((item: { type: string; text?: string }) => item.type === 'text')
          .map((item: { type: string; text?: string }) => item.text || '')
          .join('\n');
      } else {
        assistantText = content;
      }

      if (assistantText) {
        // Add to panel conversation messages for continuation support
        // Use the sessionManager method instead of db method directly to ensure event emission
        this.addPanelConversationMessage(panelId, 'assistant', assistantText);
      }
    }
    
    // Handle session completion message to stop prompt timing
    if (message?.type === 'session' && message.data?.status === 'completed') {
      // Add a completion message to trigger panel-response-added event which stops the timer
      const completionMessage = String(message.data.message || 'Session completed');
      this.addPanelConversationMessage(panelId, 'assistant', completionMessage);
    }
    
    // Handle agent messages (similar to Claude's assistant messages)
    if (message?.type === 'agent_message' || message?.type === 'agent_message_delta') {
      const agentText = String(message.message || message.delta || '');
      if (agentText && message.type === 'agent_message') {
        // Only add complete messages, not deltas
        this.addPanelConversationMessage(panelId, 'assistant', agentText);
      }
    }
    
    // Handle user conversation message extraction for Claude panels (same logic as sessions)
    if (message?.type === 'user' && messageContent) {
      // Extract text content from user messages
      const content = messageContent;
      let promptText = '';
      
      if (Array.isArray(content)) {
        // Look for text content in the array
        const textContent = content.find((item: { type: string; text?: string }) => item.type === 'text');
        if (textContent?.text) {
          promptText = textContent.text;
        }
      } else {
        promptText = content;
      }
      
      if (promptText) {
        // Note: Panel-based prompt markers would need addPanelPromptMarker method
        // For now, we rely on the explicit addPanelConversationMessage calls in IPC handlers
        // this.db.addPanelPromptMarker(panelId, promptText, outputs.length - 1);
        
        // Add to panel conversation messages for continuation support
        // Use the sessionManager method instead of db method directly to ensure event emission
        this.addPanelConversationMessage(panelId, 'user', promptText);
      }
    }

    // Capture Claude session ID per panel for proper --resume usage
    try {
      if (message) {
        const sessionIdFromMsg = (message.type === 'system' && message.subtype === 'init' && message.session_id) || message.session_id;
        if (sessionIdFromMsg) {
          const panel = this.db.getPanel(panelId);
          if (panel) {
            const currentState = panel.state || {};
            const customState = currentState.customState || {};
            const updatedState = {
              ...currentState,
              customState: {
                ...customState,
                agentSessionId: sessionIdFromMsg // Use new generic field (deprecated fields kept for read fallback only)
              }
            };
            this.db.updatePanel(panelId, { state: updatedState });
          }
        }
      }
    } catch (e) {
      console.warn('[SessionManager] Failed to persist panel-level Claude session_id:', e);
    }
  }

  getPanelOutputs(panelId: string, limit?: number): SessionOutput[] {
    const dbOutputs = this.db.getPanelOutputs(panelId, limit);
    return dbOutputs.map(dbOutput => ({
      sessionId: dbOutput.session_id || '', // For compatibility, though panels use panel_id
      type: normalizeDbOutputType(dbOutput.type),
      data: (dbOutput.type === 'json' || dbOutput.type === 'error') ? JSON.parse(dbOutput.data) : dbOutput.data,
      // SQLite timestamps are in UTC but stored without timezone indicator
      // Append 'Z' to ensure proper UTC parsing as per project documentation
      timestamp: dbOutput.timestamp.includes('T') || dbOutput.timestamp.includes('Z')
        ? new Date(dbOutput.timestamp)  // Already ISO format
        : new Date(dbOutput.timestamp + 'Z')  // SQLite format, append Z for UTC
    }));
  }

  addPanelConversationMessage(panelId: string, messageType: 'user' | 'assistant', content: string): void {
    this.db.addPanelConversationMessage(panelId, messageType, content);

    // Emit event when a user message is added (new prompt)
    if (messageType === 'user') {
      // Also add to prompt markers so the commit manager can track the latest prompt
      const outputs = this.db.getPanelOutputs(panelId);
      this.db.addPanelPromptMarker(panelId, content, outputs.length);

      this.emit('panel-prompt-added', { panelId, content });
    }

    // Emit event when an assistant message is added (response received)
    if (messageType === 'assistant') {
      this.emit('panel-response-added', { panelId, content });
    }
  }

  getPanelConversationMessages(panelId: string): ConversationMessage[] {
    return this.db.getPanelConversationMessages(panelId);
  }

  // Panel-based prompt marker methods
  getPanelPromptMarkers(panelId: string): PromptMarker[] {
    return this.db.getPanelPromptMarkers(panelId);
  }

  addPanelInitialPromptMarker(_panelId: string, _prompt: string): void {
    // Prompt markers are no longer needed for panels - using conversation_messages instead
    // The prompt is already being added to conversation_messages in addPanelConversationMessage
  }

  async continueConversation(id: string, userMessage: string): Promise<void> {
    return await withLock(`session-input-${id}`, async () => {
      // Track conversation continuation with analytics
      if (this.analyticsManager) {
        const conversationMessages = this.getConversationMessages(id);
        const messageCount = conversationMessages.length;

        // Calculate time since last message
        let timeSinceLastMessageHours = 0;
        if (conversationMessages.length > 0) {
          const lastMessage = conversationMessages[conversationMessages.length - 1];
          const lastMessageTime = new Date(lastMessage.timestamp).getTime();
          const currentTime = Date.now();
          timeSinceLastMessageHours = (currentTime - lastMessageTime) / (1000 * 60 * 60);
        }

        this.analyticsManager.track('session_continued', {
          time_since_last_message_hours: Math.round(timeSinceLastMessageHours * 10) / 10, // Round to 1 decimal
          message_count: messageCount
        });
      }

      // Store the user's message
      this.addConversationMessage(id, 'user', userMessage);
      
      // Add the continuation prompt to output so it's visible
      const timestamp = formatForDisplay(new Date());
      const userPromptDisplay = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[42m\x1b[30m 👤 USER PROMPT \x1b[0m\r\n` +
                               `\x1b[1m\x1b[92m${userMessage}\x1b[0m\r\n\r\n`;
      this.addSessionOutput(id, {
        type: 'stdout',
        data: userPromptDisplay,
        timestamp: new Date()
      });
      
      // Add a prompt marker for this continued conversation
      // Get current output count to use as index
      const outputCount = this.db.getSessionOutputCount(id);
      this.db.addPromptMarker(id, userMessage, outputCount);
      
      // Emit event for the Claude Code manager to handle
      this.emit('conversation-continue', { sessionId: id, message: userMessage });
    });
  }

  clearConversation(id: string): void {
    this.db.clearConversationMessages(id);
    this.db.clearSessionOutputs(id);
  }

  markSessionAsViewed(id: string): void {
    const updatedDbSession = this.db.markSessionAsViewed(id);
    if (updatedDbSession) {
      const session = this.convertDbSessionToSession(updatedDbSession);
      this.activeSessions.set(id, session);
      this.emit('session-updated', session);
    }
  }

  getPromptHistory(): Array<{
    id: string;
    prompt: string;
    sessionName: string;
    sessionId: string;
    createdAt: string;
    status: string;
  }> {
    const sessions = this.db.getAllSessionsIncludingArchived();
    
    return sessions.map(session => ({
      id: session.id,
      prompt: session.initial_prompt,
      sessionName: session.name,
      sessionId: session.id,
      createdAt: session.created_at,
      status: session.status
    })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getPromptById(promptId: string): PromptMarker | null {
    // For prompt history, the promptId is the sessionId
    // We need to get the initial prompt marker for that session
    const markers = this.db.getPromptMarkers(promptId);
    
    // The initial prompt is always the first marker (output_index 0)
    const initialMarker = markers.find(m => m.output_index === 0);
    
    return initialMarker || null;
  }

  getPromptMarkers(sessionId: string): PromptMarker[] {
    return this.db.getPromptMarkers(sessionId);
  }

  getSessionPrompts(sessionId: string): PromptMarker[] {
    return this.getPromptMarkers(sessionId);
  }

  addInitialPromptMarker(sessionId: string, prompt: string): void {
    try {
      // Add the initial prompt as the first prompt marker (index 0)
      this.db.addPromptMarker(sessionId, prompt, 0, 0);
    } catch (error) {
      console.error('[SessionManager] Failed to add initial prompt marker:', error);
      throw error;
    }
  }

  // Execution diff operations
  createExecutionDiff(data: CreateExecutionDiffData): ExecutionDiff {
    return this.db.createExecutionDiff(data);
  }

  getExecutionDiffs(sessionId: string): ExecutionDiff[] {
    return this.db.getExecutionDiffs(sessionId);
  }

  getExecutionDiff(id: number): ExecutionDiff | undefined {
    return this.db.getExecutionDiff(id);
  }

  getNextExecutionSequence(sessionId: string): number {
    return this.db.getNextExecutionSequence(sessionId);
  }

  getProjectRunScript(sessionId: string): string[] | null {
    const dbSession = this.getDbSession(sessionId);
    if (dbSession?.project_id) {
      const project = this.getProjectById(dbSession.project_id);
      if (project?.run_script) {
        // Split by newlines to get array of commands
        return project.run_script.split('\n').filter(cmd => cmd.trim());
      }
    }
    return null;
  }

  getProjectBuildScript(sessionId: string): string[] | null {
    const dbSession = this.getDbSession(sessionId);
    if (dbSession?.project_id) {
      const project = this.getProjectById(dbSession.project_id);
      if (project?.build_script) {
        // Split by newlines to get array of commands
        return project.build_script.split('\n').filter(cmd => cmd.trim());
      }
    }
    return null;
  }

  /** Run project cleanup commands in the same environment as setup commands. */
  runArchiveScript(sessionId: string, commands: string[], cwd: string, commandRunner: CommandRunner): Promise<{ success: boolean; output: string }> {
    return this.runScriptCommands('Archive', sessionId, commands, cwd, commandRunner);
  }

  runBuildScript(sessionId: string, commands: string[], cwd: string, commandRunner: CommandRunner): Promise<{ success: boolean; output: string }> {
    return this.runScriptCommands('Build', sessionId, commands, cwd, commandRunner);
  }

  private async runScriptCommands(label: 'Build' | 'Archive', sessionId: string, commands: string[], worktreePath: string, commandRunner: CommandRunner): Promise<{ success: boolean; output: string }> {
    const timestamp = new Date().toLocaleTimeString();
    addSessionLog(sessionId, 'info', `${label.toUpperCase()} SCRIPT RUNNING at ${timestamp}`, label);

    let allOutput = '';
    let overallSuccess = true;

    for (const command of commands) {
      if (command.trim()) {
        console.log(`[SessionManager] Executing ${label.toLowerCase()} command: ${command}`);
        addSessionLog(sessionId, 'info', `$ ${command}`, label);

        try {
          const { stdout, stderr } = await commandRunner.execAsync(command, worktreePath, label === 'Build' ? { timeout: 0 } : undefined);

          if (stdout) {
            allOutput += stdout;
            stdout.split('\n').filter(line => line.trim()).forEach(line => {
              addSessionLog(sessionId, 'info', line, label);
            });
          }
          if (stderr) {
            allOutput += stderr;
            stderr.split('\n').filter(line => line.trim()).forEach(line => {
              addSessionLog(sessionId, 'warn', line, label);
            });
          }
        } catch (cmdError) {
          console.error(`[SessionManager] ${label} command failed: ${command}`, cmdError);
          let error: CommandExecutionError = {};
          try {
            error = decodeBoundary(cmdError, boundary.object({
              stderr: boundary.optional(boundary.string),
              stdout: boundary.optional(boundary.string),
              message: boundary.optional(boundary.string),
            }));
          } catch { /* String(cmdError) remains the fallback. */ }
          const errorMessage = error.stderr || error.stdout || error.message || String(cmdError);
          allOutput += errorMessage;

          addSessionLog(sessionId, 'error', `Command failed: ${command}`, label);
          addSessionLog(sessionId, 'error', errorMessage, label);

          overallSuccess = false;
        }
      }
    }

    const endTimestamp = new Date().toLocaleTimeString();
    if (overallSuccess) {
      addSessionLog(sessionId, 'info', `✅ ${label.toUpperCase()} COMPLETED at ${endTimestamp}`, label);
    } else {
      addSessionLog(sessionId, 'error', `❌ ${label.toUpperCase()} FAILED at ${endTimestamp}`, label);
    }

    return { success: overallSuccess, output: allOutput };
  }

  addScriptOutput(sessionId: string, data: string, type: 'stdout' | 'stderr' = 'stdout'): void {
    // Send output to logs instead of terminal
    const lines = data.split('\n').filter(line => line.trim());
    lines.forEach(line => {
      const level = type === 'stderr' ? 'error' : 'info';
      addSessionLog(sessionId, level, line, 'Terminal');
    });
  }

  async cleanup(): Promise<void> {
    await this.terminalSessionManager.cleanup();
  }

  /**
   * Re-spawn every live PTY-backed terminal-session after a ptyHost
   * `UtilityProcess` restart. Delegates to the owned `TerminalSessionManager`.
   * Today this is a no-op stub; Chunk F (Task 7) fills it in when
   * `terminalSessionManager.ts:40` is routed through ptyHost.
   */
  async respawnAll(): Promise<void> {
    await this.terminalSessionManager.respawnAll();
  }

  async runTerminalCommand(sessionId: string, command: string): Promise<void> {
    // Add log entry for terminal command
    addSessionLog(sessionId, 'info', `Running terminal command: ${command}`, 'Terminal');
    
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      // Check if session exists in database and is archived
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession) {
        throw new Error('Session not found');
      }
      if (dbSession.archived) {
        throw new Error('Cannot access terminal for archived session');
      }
      throw new Error('Session not found');
    }



    const worktreePath = session.worktreePath;

    try {
      // Create terminal session if it doesn't exist
      if (!this.terminalSessionManager.hasSession(sessionId)) {
        await this.terminalSessionManager.createTerminalSession(sessionId, worktreePath);
        // Give the terminal a moment to initialize
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Send the command to the persistent terminal session
      this.terminalSessionManager.sendCommand(sessionId, command);
    } catch (error) {
      // Don't write error to terminal for archived sessions
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('archived session')) {
        this.addScriptOutput(sessionId, `\nError: ${error}\n`, 'stderr');
      }
      throw error;
    }
  }

  async sendTerminalInput(sessionId: string, data: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    let worktreePath: string;
    
    if (!session) {
      // Try to get session from database for terminal-only sessions
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession || !dbSession.worktree_path) {
        throw new Error('Session not found');
      }
      
      // Check if session is archived
      if (dbSession.archived) {
        throw new Error('Cannot access terminal for archived session');
      }
      
      worktreePath = dbSession.worktree_path;
    } else {
      worktreePath = session.worktreePath;
    }

    try {
      // Create terminal session if it doesn't exist
      if (!this.terminalSessionManager.hasSession(sessionId)) {
        await this.terminalSessionManager.createTerminalSession(sessionId, worktreePath);
        // Give the terminal a moment to initialize
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Send the raw input to the persistent terminal session
      this.terminalSessionManager.sendInput(sessionId, data);
    } catch (error) {
      // Don't write error to terminal for archived sessions
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('archived session')) {
        this.addScriptOutput(sessionId, `\nError: ${error}\n`, 'stderr');
      }
      throw error;
    }
  }

  async closeTerminalSession(sessionId: string): Promise<void> {
    await this.terminalSessionManager.closeTerminalSession(sessionId);
  }

  hasTerminalSession(sessionId: string): boolean {
    return this.terminalSessionManager.hasSession(sessionId);
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    this.terminalSessionManager.resizeTerminal(sessionId, cols, rows);
  }

  async preCreateTerminalSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    let worktreePath: string;

    if (!session) {
      // Try to get session from database for terminal-only sessions
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession || !dbSession.worktree_path) {
        throw new Error('Session not found');
      }

      // Check if session is archived
      if (dbSession.archived) {
        throw new Error('Cannot create terminal for archived session');
      }

      worktreePath = dbSession.worktree_path;
    } else {
      worktreePath = session.worktreePath;
    }

    try {
      // Create terminal session if it doesn't exist
      if (!this.terminalSessionManager.hasSession(sessionId)) {
        await this.terminalSessionManager.createTerminalSession(sessionId, worktreePath);
      }
    } catch (error) {
      console.error(`[SessionManager] Failed to pre-create terminal session: ${error}`);
      // Don't throw - this is a best-effort optimization
    }
  }

  getResumableSessions(projectId: number): ResumableSession[] {
    const dbSessions = this.db.getAllSessions(projectId);
    const interruptedSessions = dbSessions.filter(s => s.status === 'interrupted');

    const result: ResumableSession[] = [];

    for (const session of interruptedSessions) {
      const panels = this.db.getPanelsForSession(session.id);
      const resumablePanels: ResumableSession['panels'] = [];

      for (const panel of panels) {
        if (panel.type === 'terminal') {
          const termState = parseTerminalResumeState(panel.state?.customState);
          if (termState?.wasInterrupted && termState?.initialCommand) {
            const agentType = termState.agentType ?? resolveAgentTypeFromCommand(termState.initialCommand);
            const resumeId = resolveResumeId(agentType, panel.id, termState);
            if (resumeId) {
              resumablePanels.push({ panelId: panel.id, panelType: 'terminal', resumeId });
            }
          }
        }
      }

      if (resumablePanels.length > 0) {
        result.push({
          sessionId: session.id,
          sessionName: session.name,
          panels: resumablePanels
        });
      }
    }

    console.log(`[SessionManager] Resumable sessions for project ${projectId}: ${result.length} sessions with ${result.reduce((sum, s) => sum + s.panels.length, 0)} total panels`);
    return result;
  }

  async resumeInterruptedSessions(sessionIds: string[]): Promise<void> {
    console.log(`[SessionManager] resumeInterruptedSessions called with ${sessionIds.length} session(s): ${sessionIds.join(', ')}`);
    const { terminalPanelManager } = await import('./terminalPanelManager');

    for (const sessionId of sessionIds) {
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession) {
        console.warn(`[SessionManager] Session ${sessionId} not found for resume`);
        continue;
      }

      const worktreePath = dbSession.worktree_path;
      const panels = this.db.getPanelsForSession(sessionId);
      console.log(`[SessionManager] Session ${sessionId} has ${panels.length} panel(s): ${panels.map(p => `${p.id} (${p.type})`).join(', ')}`);
      let resumedPanelCount = 0;

      for (const panel of panels) {
        if (panel.type === 'terminal') {
          const termState = parseTerminalResumeState(panel.state?.customState);

          if (termState?.wasInterrupted && termState?.initialCommand) {
            const state = panel.state;
            const customState = { ...(state.customState ?? {}), ...termState };
            const agentType = customState.agentType ?? resolveAgentTypeFromCommand(customState.initialCommand);

            if (!isCliAgentType(agentType)) {
              continue;
            }
            customState.agentType = agentType;
            if (agentType === 'claude') {
              customState.hasClaudeSessionId = true;
            } else if (customState.agentSessionId) {
              console.log(`[SessionManager] Preparing ${agentType} panel ${panel.id} for captured-session resume`);
            } else {
              console.warn(`[SessionManager] ${agentType} panel ${panel.id} has no captured session id; terminal launch will use the CLI's own recovery path`);
            }

            state.customState = customState;

            // Keep DB, PanelManager cache, and renderer state aligned before terminal launch.
            await panelManager.updatePanel(panel.id, { state });

            const reloadedPanel = panelManager.getPanel(panel.id) ?? this.db.getPanel(panel.id);
            if (reloadedPanel) {
              await terminalPanelManager.initializeTerminal(reloadedPanel, worktreePath);
              console.log(`[SessionManager] Resumed terminal panel ${panel.id} via launch-time ${agentType} resolver`);
              resumedPanelCount++;
            }
          }
        }
      }

      // Update session status to running
      this.updateSession(sessionId, { status: 'running' });
      console.log(`[SessionManager] Resumed session ${sessionId}: ${resumedPanelCount} panels`);
    }
  }

  async dismissInterruptedSessions(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession) {
        console.warn(`[SessionManager] Session ${sessionId} not found for dismiss`);
        continue;
      }

      this.updateSession(sessionId, { status: 'stopped' });
    }
    console.log(`[SessionManager] Dismissed ${sessionIds.length} interrupted sessions`);
  }

}
