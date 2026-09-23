// Utility for making API calls using Electron IPC
import type { CreateSessionRequest, Session } from '../types/session';
import type { Project } from '../types/project';
import type { UpdateConfigRequest } from '../types/config';
import type { SessionCreationPreferences } from '../stores/sessionPreferencesStore';
import type { PaneChatAgent, PaneChatState } from '../../../shared/types/paneChat';
import type {
  OrchestrationAssociationInput,
  OrchestrationSessionCreateInput,
  OrchestrationSessionListResult,
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
  OrchestrationSessionSelector,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import type { UsageReportRequest } from '../../../shared/types/usage';
import type { LeaderboardResponse, LeaderboardStatus, LeaderboardSubmitResult } from '../../../shared/types/leaderboard';
import type {
  RemoteDaemonClientRecord,
  RemoteDaemonClientSettings,
  RemoteDaemonHostConfig,
  RemoteDaemonHostRuntimeState,
  RemoteHostSetupRequest,
  RemotePaneConnectionState,
  RemotePaneConnectionProfile,
} from '../../../shared/types/remoteDaemon';
import type {
  PanePermissionResponse,
} from '../../../shared/types/daemon';
import type { ProjectDashboardSessionUpdateEvent, ProjectDashboardUpdateEvent } from '../types/projectDashboard';
import type { DiffScope, FileDiffRequest } from '../../../shared/types/gitDiff';

// Type for IPC response
// oxlint-disable-next-line typescript/no-explicit-any -- Generic type parameter default for flexible API responses
export interface IPCResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
  command?: string;
  code?: string;
}

// Type for Git error response
export interface GitErrorResponse extends IPCResponse {
  gitError?: {
    command?: string;
    commands?: string[];
    output?: string;
    workingDirectory?: string;
    projectPath?: string;
    originalError?: string;
    hasConflicts?: boolean;
    conflictingFiles?: string[];
    conflictingCommits?: {
      ours: string[];
      theirs: string[];
    };
  };
}

// Check if we're running in Electron
const isElectron = () => {
  return Boolean(window.electronAPI);
};

// Wrapper class for API calls that provides error handling and consistent interface
export class API {
  static paneChat = {
    async getOrCreate(): Promise<IPCResponse<PaneChatState<Session>>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.paneChat.getOrCreate();
    },
    async setAgent(agent: PaneChatAgent): Promise<IPCResponse<PaneChatState<Session>>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.paneChat.setAgent(agent);
    },
  };

  static orchestrationSessions = {
    async list(): Promise<IPCResponse<OrchestrationSessionListResult>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.list();
    },
    async select(selector: OrchestrationSessionSelector): Promise<IPCResponse<OrchestrationSessionListResult>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.select(selector);
    },
    async create(input: OrchestrationSessionCreateInput): Promise<IPCResponse<OrchestrationSessionView<Session>>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.create(input);
    },
    async get(selector: OrchestrationSessionSelector): Promise<IPCResponse<OrchestrationSessionView<Session>>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.get(selector);
    },
    async update(selector: OrchestrationSessionSelector, input: OrchestrationSessionUpdateInput): Promise<IPCResponse<OrchestrationSessionRecord>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.update(selector, input);
    },
    async setAgent(selector: OrchestrationSessionSelector, agent: PaneChatAgent): Promise<IPCResponse<OrchestrationSessionView<Session>>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.setAgent(selector, agent);
    },
    async associate(selector: OrchestrationSessionSelector, association: OrchestrationAssociationInput): Promise<IPCResponse<OrchestrationSessionRecord>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.associate(selector, association);
    },
    async detach(selector: OrchestrationSessionSelector, paneId?: string): Promise<IPCResponse<OrchestrationSessionRecord>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.detach(selector, paneId);
    },
    async overview(selector: OrchestrationSessionSelector): Promise<IPCResponse<OrchestrationSessionOverview>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.orchestrationSessions.overview(selector);
    },
  };

  // Image export
  static export = {
    async saveImage(data: string, defaultFilename: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.export.saveImage(data, defaultFilename);
    },
    async shareImage(data: string, filename: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.export.shareImage(data, filename);
    },
  };

  // Token usage, cost and rate limits
  static usage = {
    /** Totals, time series, per-model breakdown and rolling-window state. */
    async getReport(request?: UsageReportRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.usage.getReport(request);
    },
    /** Health of the background transcript index. */
    async getStatus() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.usage.getStatus();
    },
    async rescan() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.usage.rescan();
    },
  };

  // Leaderboard
  static leaderboard = {
    async getStatus(): Promise<IPCResponse<LeaderboardStatus>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.leaderboard.getStatus();
    },
    async join(): Promise<IPCResponse<LeaderboardSubmitResult>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.leaderboard.join();
    },
    async leave(): Promise<IPCResponse> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.leaderboard.leave();
    },
    async sendNow(): Promise<IPCResponse<LeaderboardSubmitResult>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.leaderboard.sendNow();
    },
    async fetch(): Promise<IPCResponse<LeaderboardResponse>> {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.leaderboard.fetch();
    },
  };

  // Session management
  static sessions = {
    async getAll() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getAll();
    },

    async getAllWithProjects() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getAllWithProjects();
    },

    async getArchivedWithProjects() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getArchivedWithProjects();
    },

    async restore(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.restore(sessionId);
    },

    async get(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.get(sessionId);
    },

    async create(request: CreateSessionRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.create(request);
    },

    async delete(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.delete(sessionId);
    },

    async permanentDelete(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.permanentDelete(sessionId);
    },

    async permanentDeleteArchived() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.permanentDeleteArchived();
    },

    async sendInput(sessionId: string, input: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.sendInput(sessionId, input);
    },

    async continue(sessionId: string, prompt?: string, model?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.continue(sessionId, prompt, model);
    },

    async getOutput(sessionId: string, limit?: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getOutput(sessionId, limit);
    },
    async getJsonMessages(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getJsonMessages(sessionId);
    },

    async getStatistics(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getStatistics(sessionId);
    },

    async getConversation(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getConversation(sessionId);
    },

    async getConversationMessages(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getConversationMessages(sessionId);
    },

    async getConversationMessageCount(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getConversationMessageCount(sessionId);
    },

    async markViewed(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.markViewed(sessionId);
    },

    async stop(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.stop(sessionId);
    },

    async getExecutions(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getExecutions(sessionId);
    },

    async getExecutionDiff(sessionId: string, executionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getExecutionDiff(sessionId, executionId);
    },

    async gitCommit(sessionId: string, message: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitCommit(sessionId, message);
    },

    async gitDiff(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitDiff(sessionId);
    },

    async getDiffManifest(sessionId: string, scope: DiffScope) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getDiffManifest(sessionId, scope);
    },

    async getFileDiff(sessionId: string, scope: DiffScope, request: FileDiffRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getFileDiff(sessionId, scope, request);
    },

    // Main repo session
    async getOrCreateMainRepoSession(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getOrCreateMainRepoSession(projectId);
    },

    // Script operations
    async hasRunScript(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.hasRunScript(sessionId);
    },

    async getRunningSession() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getRunningSession();
    },

    async runScript(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.runScript(sessionId);
    },

    async stopScript(sessionId?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.stopScript(sessionId);
    },

    async runTerminalCommand(sessionId: string, command: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.runTerminalCommand(sessionId, command);
    },

    async sendTerminalInput(sessionId: string, data: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.sendTerminalInput(sessionId, data);
    },

    async preCreateTerminal(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.preCreateTerminal(sessionId);
    },

    async resizeTerminal(sessionId: string, cols: number, rows: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.resizeTerminal(sessionId, cols, rows);
    },

    // Prompt operations
    async getPrompts(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getPrompts(sessionId);
    },

    // Git rebase operations
    async rebaseMainIntoWorktree(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.rebaseMainIntoWorktree(sessionId);
    },

    async abortRebaseAndUseClaude(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.abortRebaseAndUseClaude(sessionId);
    },

    async squashAndRebaseToMain(sessionId: string, commitMessage: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.squashAndRebaseToMain(sessionId, commitMessage);
    },

    async rebaseToMain(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.rebaseToMain(sessionId);
    },

    // Git operation helpers
    async hasChangesToRebase(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.hasChangesToRebase(sessionId);
    },

    async generateName(prompt: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.generateName(prompt);
    },

    async rename(sessionId: string, newName: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.rename(sessionId, newName);
    },

    async toggleFavorite(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.toggleFavorite(sessionId);
    },

    async getGitCommands(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getGitCommands(sessionId);
    },

    // Git pull/push operations
    async gitPull(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitPull(sessionId);
    },

    async gitPush(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitPush(sessionId);
    },

    async gitFetch(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitFetch(sessionId);
    },

    async gitStash(sessionId: string, message?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitStash(sessionId, message);
    },

    async gitStashPop(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitStashPop(sessionId);
    },

    async gitSoftReset(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitSoftReset(sessionId);
    },

    async gitStageAndCommit(sessionId: string, message: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitStageAndCommit(sessionId, message);
    },

    async hasStash(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.hasStash(sessionId);
    },

    async setUpstream(sessionId: string, remoteBranch: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.setUpstream(sessionId, remoteBranch);
    },

    async getUpstream(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getUpstream(sessionId);
    },

    async getRemoteBranches(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getRemoteBranches(sessionId);
    },

    async getGitStatus(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getGitStatus(sessionId);
    },

    async getLastCommits(sessionId: string, count: number = 20) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getLastCommits(sessionId, count);
    },

    async getGitGraph(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getGitGraph(sessionId);
    },

    async openIDE(sessionId: string, ideKey?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.openIDE(sessionId, ideKey);
    },

    async reorder(sessionOrders: Array<{ id: string; displayOrder: number }>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.reorder(sessionOrders);
    },

    async generateCompactedContext(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.generateCompactedContext(sessionId);
    },

  };

  // Project management
  static projects = {
    async getAll() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.getAll();
    },

    async getActive() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.getActive();
    },

    async create(projectData: Omit<Project, 'id' | 'created_at' | 'updated_at'>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.create(projectData);
    },

    async activate(projectId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.activate(projectId);
    },

    async update(projectId: string, updates: Partial<Project>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.update(projectId, updates);
    },

    async delete(projectId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.delete(projectId);
    },

    async detectBranch(path: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.detectBranch(path);
    },

    async reorder(projectOrders: Array<{ id: number; displayOrder: number }>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.reorder(projectOrders);
    },

    async listBranches(projectId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.listBranches(projectId);
    },
  };

  // Git operations
  static git = {
    async cloneRepo(url: string, destDir: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.git.cloneRepo(url, destDir);
    },
  };

  // Folders
  static folders = {
    async getByProject(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.getByProject(projectId);
    },

    async create(name: string, projectId: number, parentFolderId?: string | null) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.create(name, projectId, parentFolderId);
    },

    async update(folderId: string, updates: { name?: string; display_order?: number; parent_folder_id?: string | null }) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.update(folderId, updates);
    },

    async delete(folderId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.delete(folderId);
    },

    async reorder(projectId: number, folderOrders: Array<{ id: string; displayOrder: number }>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.reorder(projectId, folderOrders);
    },

    async moveSession(sessionId: string, folderId: string | null) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.moveSession(sessionId, folderId);
    },

    async move(folderId: string, parentFolderId: string | null) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.move(folderId, parentFolderId);
    },
  };

  // Configuration
  static config = {
    async get() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.get();
    },

    async update(updates: UpdateConfigRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.update(updates);
    },

    async getSessionPreferences() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.getSessionPreferences();
    },

    async updateSessionPreferences(preferences: SessionCreationPreferences) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.updateSessionPreferences(preferences);
    },

    async getAvailableShells() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.getAvailableShells();
    },
  };

  static remoteDaemon = {
    async getConfig() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.getConfig();
    },

    async getConnectionState() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.getConnectionState();
    },

    async getHostState() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.getHostState();
    },

    async setupHost(input: RemoteHostSetupRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.setupHost(input);
    },

    async getInteractiveSetupCommand(input: RemoteHostSetupRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.getInteractiveSetupCommand(input);
    },

    async getInteractiveClientSetupCommand() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.getInteractiveClientSetupCommand();
    },

    async createConnectionPair(input: { label: string; baseUrl: string }) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.createConnectionPair(input);
    },

    async createHostConnectionCode(input?: { label?: string }) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.createHostConnectionCode(input);
    },

    async updateHostConfig(updates: Partial<RemoteDaemonHostConfig>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.updateHostConfig(updates);
    },

    async clearHostAccess() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.clearHostAccess();
    },

    async disconnectHostClients(clientIds?: string[]) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.disconnectHostClients(clientIds);
    },

    async upsertClientRecord(record: RemoteDaemonClientRecord) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.upsertClientRecord(record);
    },

    async deleteClientRecord(clientId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.deleteClientRecord(clientId);
    },

    async upsertConnectionProfile(profile: RemotePaneConnectionProfile) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.upsertConnectionProfile(profile);
    },

    async importConnectionCode(code: string, options?: { connect?: boolean }) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.importConnectionCode(code, options);
    },

    async deleteConnectionProfile(profileId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.deleteConnectionProfile(profileId);
    },

    async updateClientState(updates: Partial<Pick<RemoteDaemonClientSettings, 'activeProfileId' | 'mode'>>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.updateClientState(updates);
    },

    onConnectionStateChanged(callback: (state: RemotePaneConnectionState) => void) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.onConnectionStateChanged(callback);
    },

    onHostStateChanged(callback: (state: RemoteDaemonHostRuntimeState) => void) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.remoteDaemon.onHostStateChanged(callback);
    },
  };

  // Prompts
  static prompts = {
    async getAll() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.prompts.getAll();
    },
    
    async getByPromptId(promptId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.prompts.getByPromptId(promptId);
    },
  };

  // Dialog
  static dialog = {
    async openFile(options?: Electron.OpenDialogOptions) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dialog.openFile(options);
    },

    async openDirectory(options?: Electron.OpenDialogOptions) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dialog.openDirectory(options);
    },
  };

  // Permissions
  static permissions = {
    async respond(requestId: string, response: PanePermissionResponse) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.permissions.respond(requestId, response);
    },

    async getPending() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.permissions.getPending();
    },
  };

  // Version and updates
  static async checkForUpdates() {
    if (!isElectron()) throw new Error('Electron API not available');
    return window.electronAPI.checkForUpdates();
  }

  static async getVersionInfo() {
    if (!isElectron()) throw new Error('Electron API not available');
    return window.electronAPI.getVersionInfo();
  }

  // Dashboard
  static dashboard = {
    async getProjectStatus(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.getProjectStatus(projectId);
    },

    async getProjectStatusProgressive(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.getProjectStatusProgressive(projectId);
    },

    onUpdate(callback: (data: ProjectDashboardUpdateEvent) => void) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.onUpdate(callback);
    },

    onSessionUpdate(callback: (data: ProjectDashboardSessionUpdateEvent) => void) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.onSessionUpdate(callback);
    },
  };

  // Panels - for Claude panels and other panel types
  static panels = {
    async getOutput(panelId: string, limit?: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getOutput(panelId, limit);
    },

    async getConversationMessages(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getConversationMessages(panelId);
    },

    async getJsonMessages(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getJsonMessages(panelId);
    },

    async getPrompts(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getPrompts(panelId);
    },

    async sendInput(panelId: string, input: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.sendInput(panelId, input);
    },

    async continue(panelId: string, input: string, model?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.continue(panelId, input, model);
    },
  };


  // Spotlight
  static spotlight = {
    async enable(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.spotlight.enable(sessionId);
    },

    async disable(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.spotlight.disable(sessionId);
    },

    async getStatus(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.spotlight.getStatus(projectId);
    },
  };
}

// Legacy support - removed as migration is complete
// All HTTP API calls have been migrated to IPC via the API class
