import type { AgentState, PanelAgentStatusEvent } from '../../../../shared/types/agentStatus';
import { nativeChatHookSettings } from './hookSettings';
import { databaseService } from '../database';
import { mkdirSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolPanel } from '../../../../shared/types/panels';
import { getAppDirectory } from '../../utils/appDirectory';
import { findExecutableInPath } from '../../utils/shellPath';
import { getPaneEventSink, getRuntimeConfigManager } from '../../core/runtime';
import { quoteShellWord } from '../agents/shellWord';
import { claudeChatProfile, codexChatProfile, type CodexChatProfile } from './launchProfile';
import { CodexProcess, CODEX_TOKEN_ENV } from './codexProcess';
import { hostCommand, nativeCommand, providerScript } from './hostCommand';
import { ArchiveProcessTracker, readArchiveProcesses } from '../archiveProcessTracker';
import { NativeHookJournal } from './nativeHookJournal';
import { SessionController, type ConversationRecord, type RuntimeDriver } from './sessionController';
import { AcpProcess } from './acpProcess';
import { TranscriptProjection } from './transcriptProjection';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

import type { AgentChatPanelState, AgentChatView, AgentInterface, AgentChatSend, AgentChatReceipt } from '../../../../shared/types/agentChat';
import type { TerminalPanelState } from '../../../../shared/types/panels';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { panelManager } from '../panelManager';
import { adapterEntry, installAdapter } from './adapterSetup';

const execFileAsync = promisify(execFile);
export interface NativeChatPort {
  executable?(panelId: string): Promise<string | undefined>;
  publishStatus?(event: PanelAgentStatusEvent): void;
  pid(panelId: string): number | undefined;
  writeControl(panelId: string, data: string): void;
  destroy(panelId: string): Promise<void>;
  initialize(panelId: string, cwd: string, updateOperationId?: string): Promise<void>;
}
export interface AgentChatManagerOptions {
  enabled?: () => boolean;
}

/** The host owns runtime lifetime; desktop and remote callers share this instance. */
export class AgentChatManager {
  private native?: NativeChatPort;
  private readonly known = new Set<string>();
  private readonly publishedStates = new Map<string, AgentState>();
  private readonly journals = new Map<string, NativeHookJournal>();
  private readonly trackers = new Map<string, ArchiveProcessTracker>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly observationErrors = new Map<string, string>();
  private readonly controllers = new Map<string, SessionController>();
  private readonly adapters = new Map<string, AcpProcess>();
  private readonly codex = new Map<string, CodexProcess>();
  private readonly transcripts = new Map<string, TranscriptProjection>();
  private readonly environments = new Map<string, NodeJS.ProcessEnv>();
  private readonly acquiring = new Set<string>();
  private readonly observations = new Map<string, Promise<void>>();
  private readonly updateOperations = new Map<string, string>();
  private readonly launchInputs = new Map<string, string>();
  private readonly adopting = new Set<string>();
  private readonly legacyCodex = new Map<string, { cwd: string; env: NodeJS.ProcessEnv; shellType: string; profile: CodexChatProfile; executable: string }>();

  constructor(private readonly options: AgentChatManagerOptions = {}) {}

  attachNative(port: NativeChatPort): void { this.native = port; }
  private enabled(): boolean { return this.options.enabled?.() ?? getRuntimeConfigManager().getConfig().agentChatEnabled !== false; }
  private session(panelId: string) { return this.codex.get(panelId)?.session ?? this.adapters.get(panelId)?.session; }

  private async prepareCodex(panel: ToolPanel, cwd: string, env: NodeJS.ProcessEnv, shellType: string, profile: CodexChatProfile, preference?: AgentInterface): Promise<boolean> {
    const running = this.codex.get(panel.id);
    if (running) { env[CODEX_TOKEN_ENV] = running.token; return false; }
    // SAFETY: TerminalPanelManager supplies a terminal panel before native spawn.
    const state = panel.state.customState as TerminalPanelState | undefined;
    if (!state || state.launchMode || state.preserveLaunchCommand || state.customResume || state.sshHost) return false;
    const previous = this.record(panel.id);
    if (previous && this.acquiring.has(panel.id)) {
      this.environments.set(panel.id, { ...env });
      const runtime = await this.startCodex(previous.conversation);
      await runtime.session.load({ sessionId: previous.conversation.nativeSessionId, cwd: previous.launch.cwd, mcpServers: [] });
      env[CODEX_TOKEN_ENV] = runtime.token;
      return false;
    }
    // Existing daemon conversations require attachment to their original owner;
    // never load their ID into an unrelated newly spawned server.
    if (state.agentSessionId || state.agentChat || profile.remote) return false;
    const executable = path.isAbsolute(profile.executable) ? profile.executable : findExecutableInPath(profile.executable);
    if (!executable) return false;
    const command = hostCommand(executable, ['--version']);
    const { stdout } = await execFileAsync(command.executable, command.args, { cwd, env, windowsVerbatimArguments: command.windowsVerbatimArguments, timeout: 5000, maxBuffer: 16 * 1024 });
    const directory = path.join(getAppDirectory(), 'agent-chat', createHash('sha256').update(panel.id).digest('hex'), randomUUID());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const active = preference ?? getRuntimeConfigManager().getConfig().defaultAgentInterface ?? 'terminal';
    const saved: AgentChatPanelState = {
      conversation: { panelId: panel.id, workspaceId: panel.sessionId, provider: 'codex', nativeSessionId: '', active: 'stopped', preferred: active, generation: 0, recovery: 'Preparing Codex…' },
      launch: { command: state.launchCommand ?? state.initialCommand ?? '', cwd, shellType, executable, version: stdout.trim(), strictMcpConfig: false, journalFile: '', settingsFile: path.join(directory, 'codex.json'), codexConfigArgs: profile.configArgs },
      processes: { terminal: [], chat: [] },
    };
    this.known.add(panel.id);
    panelManager.commitAgentChat(panel.id, saved);
    this.environments.set(panel.id, { ...env });
    this.controller(panel.id);
    try {
      const runtime = await this.startCodex(saved.conversation);
      await runtime.session.create({ cwd, mcpServers: [] }, panel.title || 'Pane conversation');
      panelManager.commitAgentChat(panel.id, { ...this.required(panel.id), conversation: { ...this.required(panel.id).conversation, active, generation: 1, recovery: undefined } });
      env[CODEX_TOKEN_ENV] = runtime.token;
      this.publish(panel.id);
      if (active === 'chat' && state.initialInput) {
        this.send(panel.id, { generation: 1, operationId: `initial:${panel.id}`, text: state.initialInput });
        const current = panelManager.getPanel(panel.id)!;
        await panelManager.updatePanel(panel.id, { state: { ...current.state, customState: { ...current.state.customState, initialInputSentAt: new Date().toISOString() } } });
      }
      return active === 'chat';
    } catch (error) {
      let release = '';
      try { await this.codex.get(panel.id)?.release(); this.codex.delete(panel.id); } catch (failure) { release = ` Release remains unverified: ${reasonOf(failure)}.`; }
      panelManager.commitAgentChat(panel.id, { ...this.required(panel.id), conversation: { ...this.required(panel.id).conversation, active: 'stopped', recovery: `Codex startup failed: ${reasonOf(error)}.${release}` } });
      this.publish(panel.id);
      return true;
    }
  }

  private async startCodex(record: ConversationRecord): Promise<CodexProcess> {
    const saved = this.required(record.panelId);
    const generation = record.generation + 1;
    const projection = new TranscriptProjection(record.panelId, generation);
    this.transcripts.set(record.panelId, projection);
    panelManager.commitAgentChat(record.panelId, { ...saved, processes: { ...saved.processes, unverifiedSpawn: 'chat' } });
    const runtime = new CodexProcess({
      executable: saved.launch.executable, configArgs: saved.launch.codexConfigArgs ?? [], cwd: saved.launch.cwd,
      env: this.environments.get(record.panelId) ?? process.env, directory: path.dirname(saved.launch.settingsFile), generation, socketPath: saved.launch.codexSocketPath,
      save: identities => panelManager.commitAgentChat(record.panelId, { ...this.required(record.panelId), processes: { ...this.required(record.panelId).processes, chat: structuredClone(identities), unverifiedSpawn: undefined } }),
      onIdentity: nativeSessionId => panelManager.commitAgentChat(record.panelId, { ...this.required(record.panelId), conversation: { ...this.required(record.panelId).conversation, nativeSessionId } }),
      onChange: change => {
        const event = projection.acceptChange(change);
        if (!projection.error()) getPaneEventSink().send('agent-chat:event', event);
      },
      onState: () => this.publish(record.panelId),
      onDisconnect: () => {
        const current = this.record(record.panelId);
        if (current && current.conversation.active !== 'stopped') {
          panelManager.commitAgentChat(record.panelId, { ...current, conversation: { ...current.conversation, active: 'stopped', recovery: 'The Codex connection closed. Verify its recorded runtime before recovery.' } });
        }
      },
    });
    try {
      await runtime.start();
      this.codex.set(record.panelId, runtime);
      await runtime.session.initialize();
      panelManager.commitAgentChat(record.panelId, { ...this.required(record.panelId), launch: { ...this.required(record.panelId).launch, codexEndpoint: runtime.endpoint } });
      return runtime;
    } catch (error) {
      await runtime.release();
      this.codex.delete(record.panelId);
      throw error;
    }
  }

  private async handoffCodex(record: ConversationRecord, target: AgentInterface) {
    const runtime = this.codex.get(record.panelId);
    if (!runtime) throw new PaneError('CHAT_RECOVERY_REQUIRED', 'The Codex server is no longer connected.', 'Recover the recorded conversation before switching.');
    await runtime.session.verifyIdentity(record.nativeSessionId);
    if (target === 'terminal' && !this.native?.pid(record.panelId)) {
      this.acquiring.add(record.panelId);
      try { await this.native!.initialize(record.panelId, this.required(record.panelId).launch.cwd); }
      finally { this.acquiring.delete(record.panelId); }
    }
    runtime.session.setGeneration(record.generation + 1);
    this.transcripts.get(record.panelId)?.setGeneration(record.generation + 1);
    return { nativeSessionId: record.nativeSessionId, historyVerified: true };
  }

  async prepareFreshChat(panel: ToolPanel, cwd: string, env: NodeJS.ProcessEnv, shellType: string, isWSL: boolean, preference?: AgentInterface): Promise<boolean> {
    // SAFETY: TerminalPanelManager supplies a terminal panel before native spawn.
    const terminal = panel.state.customState as TerminalPanelState | undefined;
    const codexProfile = codexChatProfile(terminal?.launchCommand ?? terminal?.initialCommand ?? '');
    if (codexProfile && this.enabled() && !isWSL) return this.prepareCodex(panel, cwd, env, shellType, codexProfile, preference);
    if ((preference ?? getRuntimeConfigManager().getConfig().defaultAgentInterface) !== 'chat' || !this.enabled() || isWSL) return false;
    // SAFETY: TerminalPanelManager supplies a terminal panel before any PTY is spawned.
    const state = panel.state.customState as TerminalPanelState | undefined;
    if (!state || state.agentSessionId || state.agentChat || state.isInitialized || state.initialInputSentAt || state.launchMode || state.preserveLaunchCommand || state.customResume || state.sshHost) return false;
    const profile = claudeChatProfile(state.launchCommand ?? state.initialCommand ?? '');
    if (!profile) return false;
    const executable = path.isAbsolute(profile.executable) ? profile.executable : findExecutableInPath(profile.executable);
    if (!executable) return false;
    const versionCommand = hostCommand(executable, ['--version']);
    const { stdout } = await execFileAsync(versionCommand.executable, versionCommand.args, { cwd, env, windowsVerbatimArguments: versionCommand.windowsVerbatimArguments, timeout: 5000, maxBuffer: 16 * 1024 });
    const version = stdout.trim();
    const directory = path.join(getAppDirectory(), 'agent-chat', createHash('sha256').update(panel.id).digest('hex'), randomUUID());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const journalFile = path.join(directory, 'lifecycle.jsonl'), settingsFile = path.join(directory, 'settings.json');
    const settings = nativeChatHookSettings(journalFile);
    writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    const saved: AgentChatPanelState = {
      conversation: { panelId: panel.id, workspaceId: panel.sessionId, provider: 'claude', nativeSessionId: '', active: 'stopped', preferred: 'chat', generation: 0, recovery: 'Creating a new conversation; its identity has not been returned yet.' },
      launch: { ...profile, command: state.launchCommand ?? state.initialCommand ?? '', cwd, shellType, executable, version, journalFile, settingsFile },
      processes: { terminal: [], chat: [] },
    };
    this.known.add(panel.id);
    panelManager.commitAgentChat(panel.id, saved);
    this.environments.set(panel.id, { ...env });
    this.controller(panel.id);
    try {
      const runtime = await this.startAdapter(saved.conversation);
      const created = await runtime.session.create({ cwd, mcpServers: [], _meta: { claudeCode: { options: { settings, strictMcpConfig: profile.strictMcpConfig, additionalDirectories: profile.additionalDirectories ?? [] } } } });
      const identified = { ...this.required(panel.id), conversation: { ...saved.conversation, nativeSessionId: created.sessionId } };
      panelManager.commitAgentChat(panel.id, identified);
      this.journals.set(panel.id, new NativeHookJournal(journalFile, created.sessionId));
      if (profile.permissionMode && created.modes?.currentModeId !== profile.permissionMode) await runtime.session.configure('mode', profile.permissionMode);
      if (profile.model) await runtime.session.configure('model', profile.model);
      if (profile.effort) await runtime.session.configure('effort', profile.effort);
      panelManager.commitAgentChat(panel.id, { ...this.required(panel.id), conversation: { ...identified.conversation, generation: 1, active: 'chat', recovery: undefined } });
      const current = panelManager.getPanel(panel.id)!;
      await panelManager.updatePanel(panel.id, { state: { ...current.state, customState: { ...current.state.customState, agentType: 'claude', agentSessionId: created.sessionId, isCliPanel: true } } });
      this.publish(panel.id);
      if (state.initialInput) {
        this.send(panel.id, { generation: 1, operationId: `initial:${panel.id}`, text: state.initialInput });
        const current = panelManager.getPanel(panel.id)!;
        await panelManager.updatePanel(panel.id, { state: { ...current.state, customState: { ...current.state.customState, initialInputSentAt: new Date().toISOString() } } });
      }
      return true;
    } catch (error) {
      let cleanup = '';
      try { await this.release(panel.id, 'chat'); } catch (releaseError) { cleanup = ` Release remains unverified: ${reasonOf(releaseError)}.`; }
      const current = this.required(panel.id);
      panelManager.commitAgentChat(panel.id, { ...current, conversation: { ...current.conversation, active: 'stopped', recovery: `Chat startup failed: ${reasonOf(error)}.${cleanup}` } });
      this.publish(panel.id);
      // A created identity is never replaced by a native fallback after failure.
      return true;
    }
  }

  async prepareNativeLaunch(panel: ToolPanel, cwd: string, env: NodeJS.ProcessEnv, command: string, shellType: string, isWSL: boolean): Promise<string> {
    const codex = this.codex.get(panel.id);
    if (codex) {
      const saved = this.required(panel.id);
      const input = nativeCommand(saved.launch.executable, ['resume', saved.conversation.nativeSessionId, '--remote', codex.endpoint, ...(saved.launch.codexSocketPath ? [] : ['--remote-auth-token-env', CODEX_TOKEN_ENV])], shellType);
      this.launchInputs.set(panel.id, `${input}\r`);
      const pid = this.native?.pid(panel.id);
      if (!pid) throw new PaneError('CHAT_NATIVE_OWNER_MISSING', 'The native terminal disappeared before Codex attached.', 'Retry the interface switch.');
      const tracker = new ArchiveProcessTracker([], identities => panelManager.commitAgentChat(panel.id, { ...this.required(panel.id), processes: { ...this.required(panel.id).processes, terminal: structuredClone(identities) } }));
      this.trackers.set(panel.id, tracker);
      await tracker.capture([pid]);
      return input;
    }
    // Older tabs keep their native launch untouched until their user identifies
    // the current thread/owner. Retain the real launch environment for that step.
    // SAFETY: TerminalPanelManager invokes this only for terminal panels.
    const legacyState = panel.state.customState as TerminalPanelState | undefined;
    const legacy = codexChatProfile(legacyState?.launchCommand ?? legacyState?.initialCommand ?? '');
    if (legacy && this.enabled() && !isWSL) {
      const executable = path.isAbsolute(legacy.executable) ? legacy.executable : findExecutableInPath(legacy.executable);
      if (executable) this.legacyCodex.set(panel.id, { cwd, env: { ...env }, shellType, profile: legacy, executable });
      return command;
    }
    if ((!this.enabled() && !this.acquiring.has(panel.id)) || isWSL) return command;
    // SAFETY: Only TerminalPanelManager calls this for a native terminal launch.
    const state = panel.state.customState as TerminalPanelState | undefined;
    if (!state?.agentSessionId || state.launchMode || state.preserveLaunchCommand || state.customResume || state.sshHost) return command;
    const profile = claudeChatProfile(state.launchCommand ?? state.initialCommand ?? '');
    if (!profile) return command;
    const executable = path.isAbsolute(profile.executable) ? profile.executable : findExecutableInPath(profile.executable);
    if (!executable) return command;
    const versionCommand = hostCommand(executable, ['--version']);
    const { stdout } = await execFileAsync(versionCommand.executable, versionCommand.args, { cwd, env, windowsVerbatimArguments: versionCommand.windowsVerbatimArguments, timeout: 5000, maxBuffer: 16 * 1024 });
    const version = stdout.trim();
    const directory = path.join(getAppDirectory(), 'agent-chat', createHash('sha256').update(panel.id).digest('hex'), randomUUID());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const journalFile = path.join(directory, 'lifecycle.jsonl');
    const settingsFile = path.join(directory, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify(nativeChatHookSettings(journalFile)), { mode: 0o600 });
    const previous = this.record(panel.id);
    if (previous && !this.acquiring.has(panel.id)) throw new PaneError('CHAT_RECOVERY_REQUIRED', 'This conversation already has an ownership record. No replacement native agent was started.', 'Use explicit recovery to resume the exact conversation.');
    for (const otherId of databaseService.getAgentChatPanelIds()) {
      if (otherId === panel.id) continue;
      const other = this.record(otherId)?.conversation;
      if (other?.provider === 'claude' && other.nativeSessionId === state.agentSessionId) throw new PaneError('CHAT_CONVERSATION_OWNED', 'Another tab already owns this exact conversation. No agent was started.', 'Use the existing conversation tab.');
    }
    const saved: AgentChatPanelState = {
      conversation: previous?.conversation ?? { panelId: panel.id, workspaceId: panel.sessionId, provider: 'claude', nativeSessionId: state.agentSessionId, active: 'terminal', preferred: 'terminal', generation: 1 },
      launch: { ...profile, ...previous?.launch, command: state.launchCommand ?? state.initialCommand ?? '', cwd, shellType, executable, version, journalFile, settingsFile },
      processes: { ...(previous?.processes ?? { terminal: [], chat: [] }), unverifiedSpawn: 'terminal' },
    };
    this.known.add(panel.id);
    panelManager.commitAgentChat(panel.id, saved);
    this.environments.set(panel.id, { ...env });
    this.journals.set(panel.id, new NativeHookJournal(journalFile, state.agentSessionId));
    const tracker = new ArchiveProcessTracker([], identities => {
      const current = this.record(panel.id);
      if (current && JSON.stringify(current.processes.terminal) !== JSON.stringify(identities)) panelManager.commitAgentChat(panel.id, { ...current, processes: { ...current.processes, terminal: structuredClone(identities), unverifiedSpawn: current.processes.unverifiedSpawn === 'terminal' ? undefined : current.processes.unverifiedSpawn } });
    });
    this.trackers.set(panel.id, tracker);
    const pid = this.native?.pid(panel.id);
    if (!pid) throw new PaneError('CHAT_NATIVE_OWNER_MISSING', 'The native terminal owner disappeared before launch. The agent was not started.', 'Resume this tab after inspecting its stopped state.');
    await tracker.capture([pid]);
    let observing = false;
    let checkpointReady: boolean | undefined;
    const timer = setInterval(() => {
      const current = this.record(panel.id);
      if (current?.conversation.active === 'terminal' && !current.conversation.transition && this.journals.get(panel.id)?.ended()) {
        panelManager.commitAgentChat(panel.id, { ...current, conversation: { ...current.conversation, active: 'stopped', generation: current.conversation.generation + 1, pendingSwitch: undefined, recovery: 'The native agent exited. Recover this exact conversation to continue.' } });
        this.publish(panel.id);
      }
      if (this.record(panel.id)?.conversation.active === 'terminal' && !current?.conversation.transition) {
        const ready = this.journals.get(panel.id)?.checkpoint().ready ?? false;
        if (ready !== checkpointReady) {
          checkpointReady = ready;
          this.publish(panel.id);
        }
      }
      if (observing) return;
      observing = true;
      const observation = tracker.refresh().catch(error => { this.observationErrors.set(panel.id, error instanceof Error ? error.message : String(error)); }).finally(() => { observing = false; });
      this.observations.set(panel.id, observation);
    }, 200);
    timer.unref();
    this.timers.set(panel.id, timer);
    const base = previous ? nativeCommand(saved.launch.executable, [
      ...(saved.launch.model ? ['--model', saved.launch.model] : []),
      ...(saved.launch.effort ? ['--effort', saved.launch.effort] : []),
      ...(saved.launch.permissionMode === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : saved.launch.permissionMode ? ['--permission-mode', saved.launch.permissionMode] : []),
      ...(saved.launch.strictMcpConfig ? ['--strict-mcp-config'] : []),
      ...(saved.launch.additionalDirectories ?? []).flatMap(directory => ['--add-dir', directory]),
      '--resume', saved.conversation.nativeSessionId,
    ], shellType) : command;
    const augmented = `${base} --settings ${quoteShellWord(settingsFile, shellType)}`;
    this.launchInputs.set(panel.id, `${augmented}\r`);
    return augmented;
  }

  detachObservers(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private record(panelId: string): AgentChatPanelState | undefined {
    const panel = panelManager.getPanel(panelId);
    if (panel?.type !== 'terminal') return;
    // SAFETY: Terminal panels persist TerminalPanelState; only commitAgentChat
    // can replace its host-owned runtime record.
    return (panel.state.customState as TerminalPanelState | undefined)?.agentChat;
  }

  private reconcile(panelId: string): void {
    if (this.known.has(panelId)) return;
    const saved = this.record(panelId);
    if (!saved) return;
    this.known.add(panelId);
    if (saved.conversation.active !== 'stopped' || saved.conversation.transition) {
      panelManager.commitAgentChat(panelId, { ...saved, conversation: { ...saved.conversation, active: 'stopped', recovery: 'Pane restarted without a live runtime handle. Verify release before recovering this exact conversation.' } });
    }
  }

  mode(panelId: string): AgentInterface | 'stopped' | undefined {
    this.reconcile(panelId);
    return this.record(panelId)?.conversation.active;
  }

  status(panelId: string): AgentState | undefined {
    const saved = this.record(panelId);
    if (!saved || saved.conversation.active === 'terminal') return;
    if (saved.conversation.active === 'stopped') return 'unknown';
    const view = this.view(panelId, false);
    return view.permissions.length ? 'blocked' : view.running ? 'working' : view.error ? 'blocked' : 'idle';
  }

  private publish(panelId: string): void {
    const view = this.view(panelId, false);
    getPaneEventSink().send('agent-chat:state', view);
    const state = this.status(panelId);
    if (!state || this.publishedStates.get(panelId) === state) return;
    const previous = this.publishedStates.get(panelId);
    this.publishedStates.set(panelId, state);
    const payload: PanelAgentStatusEvent = { panelId, sessionId: this.required(panelId).conversation.workspaceId, agentType: this.required(panelId).conversation.provider, state, reason: state === 'blocked' ? view.error ?? 'ACP permission requested' : view.conversation?.recovery ?? null, workedVisibly: state === 'idle' ? previous === 'working' : undefined };
    getPaneEventSink().send('panel:agentStatus', payload);
    this.native?.publishStatus?.(payload);
  }

  view(panelId: string, includeTranscript = true): AgentChatView {
    this.reconcile(panelId);
    const saved = this.record(panelId);
    const unavailableReason = saved ? undefined : 'This terminal has no verified conversation connection. Launch Claude or Codex directly with Chat enabled, or inspect its launch configuration.';
    const adapter = this.session(panelId);
    const lastReceipt = saved?.receipts?.at(-1);
    // The protocol clears its running flag before its promise settles here.
    // Keep the host turn working until finish() durably commits the outcome;
    // otherwise a rejection briefly emits a false idle/completion notification.
    const awaitingResult = saved?.conversation.active === 'chat' && lastReceipt?.generation === saved.conversation.generation && lastReceipt.state === 'accepted';
    return {
      panelId, conversation: saved?.conversation, available: !!saved && !this.adopting.has(panelId), unavailableReason, identificationRequired: !saved && this.legacyCodex.has(panelId),
      setupRequired: saved?.conversation.provider === 'claude' && !adapterEntry('claude'), running: saved?.conversation.active === 'terminal' && saved.conversation.provider === 'claude' ? !this.journals.get(panelId)?.checkpoint().ready : awaitingResult || (adapter?.isRunning() ?? false), canAttachImages: adapter?.supportsImages() ?? false,
      controls: adapter?.controls(),
      permissions: this.codex.get(panelId)?.session.permissions() ?? this.adapters.get(panelId)?.session.permissions().map(permission => ({ id: permission.id, generation: permission.generation,
        title: permission.request.toolCall.title ?? 'Permission requested',
        toolCall: decodeBoundary(permission.request.toolCall, boundary.json), options: permission.request.options })) ?? [],
      transcript: includeTranscript ? this.transcripts.get(panelId)?.snapshot() : undefined,
      error: this.transcripts.get(panelId)?.error() ?? this.codex.get(panelId)?.session.error() ?? (lastReceipt?.generation === saved?.conversation.generation && lastReceipt?.state === 'failed'
        ? `The agent could not complete this turn: ${lastReceipt.error ?? 'The provider rejected the request'}. Check the provider connection and settings, then send a new turn when ready.` : undefined),
      configuration: adapter?.config() ? decodeBoundary(adapter.config(), boundary.json) : undefined,
    };
  }

  guardNativeInput(panelId: string, data: string): void {
    this.reconcile(panelId);
    if (this.adopting.has(panelId)) throw new PaneError('CHAT_TRANSITION_IN_PROGRESS', 'Pane is identifying this conversation. No terminal input was sent.', 'Wait for identification to finish.');
    const record = this.record(panelId)?.conversation;
    if (!record) return;
    if (this.acquiring.has(panelId) && this.launchInputs.get(panelId) === data) { this.launchInputs.delete(panelId); return; }
    if (record.transition || record.active === 'stopped') throw new PaneError('CHAT_STOPPED', 'The conversation is switching or stopped. No terminal input was sent.', 'Wait for the transition or recover the exact conversation.');
    if (record.active === 'chat') throw new PaneError('CHAT_RAW_TERMINAL_UNSUPPORTED', 'Raw terminal input is unavailable while Chat owns this conversation. No input was sent.', 'Send a semantic prompt or switch to Terminal.');
    if (this.launchInputs.get(panelId) === data) { this.launchInputs.delete(panelId); return; }
    this.journals.get(panelId)?.input(data);
  }

  private required(panelId: string): AgentChatPanelState {
    this.reconcile(panelId);
    const saved = this.record(panelId);
    if (!saved) throw new PaneError('CHAT_PROFILE_UNSUPPORTED', this.view(panelId).unavailableReason ?? 'The runtime is not ready to switch.', 'Keep using Terminal and review Chat setup.');
    return saved;
  }

  private controller(panelId: string): SessionController {
    const existing = this.controllers.get(panelId);
    if (existing) return existing;
    this.required(panelId);
    const driver: RuntimeDriver = {
      preflight: (record, target) => this.preflight(record, target),
      checkpoint: async record => {
        const error = this.observationErrors.get(record.panelId);
        if (error) return { ready: false, reason: `Runtime ownership observation failed: ${error}` };
        const adapter = this.adapters.get(record.panelId)?.session;
        if (adapter?.isRunning() || adapter?.permissions().length) return { ready: false, reason: 'The agent is working or waiting for permission. Wait for its turn to finish.' };
        const checkpoint = this.journals.get(record.panelId)?.checkpoint() ?? { ready: false, reason: 'The native runtime has no verified checkpoint.' };
        if (checkpoint.ready && record.active === 'terminal' && this.native?.executable) {
          const executable = await this.native.executable(record.panelId);
          if (!executable || realpathSync(executable) !== realpathSync(this.required(record.panelId).launch.executable)) return { ready: false, reason: 'The native foreground executable does not match the validated CLI. Keep this tab in Terminal.' };
        }
        if (checkpoint.ready) this.captureConfiguration(record.panelId);
        return checkpoint;
      },
      release: (record, mode) => this.release(record.panelId, mode),
      acquire: (record, mode, options) => this.acquire(record, mode, options),
    };
    if (this.required(panelId).conversation.provider === 'codex') driver.handoff = (record, target) => this.handoffCodex(record, target);
    const controller = new SessionController({
      read: () => structuredClone(this.required(panelId).conversation),
      write: conversation => { panelManager.commitAgentChat(panelId, { ...this.required(panelId), conversation }); this.publish(panelId); },
    }, driver, () => this.enabled());
    this.controllers.set(panelId, controller);
    return controller;
  }

  private async preflight(record: ConversationRecord, target: AgentInterface): Promise<void> {
    if (this.adopting.has(record.panelId)) throw new PaneError('CHAT_TRANSITION_IN_PROGRESS', 'This conversation is being identified.', 'Wait for identification to finish.');
    if (record.provider === 'codex') {
      const runtime = this.codex.get(record.panelId);
      if (!runtime && record.active === 'stopped' && target === 'terminal' && this.native) return;
      if (!runtime) throw new PaneError('CHAT_RECOVERY_REQUIRED', 'The saved Codex server is not connected. No second owner was started.', 'Recover in Terminal to restore its original launch environment.');
      await runtime.session.verifyIdentity(record.nativeSessionId);
      return;
    }
    const saved = this.required(record.panelId);
    if (target === 'chat' && !this.environments.has(record.panelId)) throw new PaneError('CHAT_ENVIRONMENT_UNVERIFIED', 'The original launch environment is no longer in memory. Chat recovery did not start.', 'Recover this exact conversation in Terminal first; its normal launcher restores the workspace environment.');
    if (!this.native) throw new PaneError('CHAT_NATIVE_OWNER_MISSING', 'The native terminal owner is unavailable.', 'Restart Pane before recovering this conversation.');
    const command = hostCommand(saved.launch.executable, ['--version']);
    await execFileAsync(command.executable, command.args, { timeout: 5000, maxBuffer: 16 * 1024, env: this.environments.get(record.panelId), windowsVerbatimArguments: command.windowsVerbatimArguments });
    if (target === 'chat' && !this.adapters.has(record.panelId)) await this.startAdapter(record);
  }

  private async startAdapter(record: ConversationRecord): Promise<AcpProcess> {
    await installAdapter(record.provider);
    const entry = adapterEntry(record.provider);
    if (!entry) throw new PaneError('CHAT_ADAPTER_MISSING', 'Chat setup finished without a usable adapter. The conversation was not replaced.', 'Retry Chat setup on the workspace host.');
    const saved = this.required(record.panelId);
    const projection = new TranscriptProjection(record.panelId, record.generation + 1);
    this.transcripts.set(record.panelId, projection);
    panelManager.commitAgentChat(record.panelId, { ...saved, processes: { ...saved.processes, unverifiedSpawn: 'chat' } });
    const runtime = new AcpProcess({
      executable: process.execPath, args: [entry], cwd: saved.launch.cwd,
      env: { ...(this.environments.get(record.panelId) ?? process.env), ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: providerScript(saved.launch.executable, 'claude') ?? saved.launch.executable },
      generation: record.generation + 1,
      save: identities => {
        const current = this.required(record.panelId);
        panelManager.commitAgentChat(record.panelId, { ...current, processes: { ...current.processes, chat: structuredClone(identities), unverifiedSpawn: undefined } });
      },
      onForkRequested: () => {
        const current = this.required(record.panelId);
        if (current.conversation.forkUnconfirmed) throw new PaneError('CHAT_FORK_UNCONFIRMED', 'A previous history copy did not return its identity. No further fork was requested.', 'Inspect the provider history before retrying a history copy; the original conversation is preserved.');
        panelManager.commitAgentChat(record.panelId, { ...current, conversation: { ...current.conversation, forkUnconfirmed: true } });
      },
      onIdentity: nativeSessionId => {
        const current = this.required(record.panelId);
        panelManager.commitAgentChat(record.panelId, { ...current, conversation: { ...current.conversation, nativeSessionId, forkUnconfirmed: undefined } });
        this.journals.set(record.panelId, new NativeHookJournal(current.launch.journalFile, nativeSessionId));
      },
      onDisconnect: () => {
        const current = this.record(record.panelId);
        if (current?.conversation.active === 'chat' && !current.conversation.transition && current.conversation.generation === record.generation + 1) {
          panelManager.commitAgentChat(record.panelId, { ...current, conversation: { ...current.conversation, active: 'stopped', recovery: 'The Chat connection ended unexpectedly. Verify release and recover this exact conversation.' } });
        }
      },
      onUpdate: notification => {
        const previousError = projection.error();
        const event = projection.accept(notification.update);
        if (!projection.error()) getPaneEventSink().send('agent-chat:event', event);
        else if (!previousError) this.publish(record.panelId);
      },
      onState: () => this.publish(record.panelId),
    });
    this.adapters.set(record.panelId, runtime);
    try {
      await runtime.start();
      const capabilities = await runtime.session.initialize();
      if (!capabilities.agentCapabilities?.loadSession) throw new PaneError('CHAT_IMPORT_UNSUPPORTED', 'The adapter cannot load an existing conversation.', 'Keep this tab in Terminal.');
      return runtime;
    } catch (error) {
      await this.release(record.panelId, 'chat');
      throw error;
    }
  }

  private async stopObserving(panelId: string): Promise<void> {
    const timer = this.timers.get(panelId);
    if (timer) clearInterval(timer);
    this.timers.delete(panelId);
    await this.observations.get(panelId);
  }

  private async release(panelId: string, mode: AgentInterface): Promise<void> {
    const unverified = this.required(panelId).processes.unverifiedSpawn;
    if (unverified === mode) throw new PaneError('CHAT_SPAWN_UNVERIFIED', 'The host stopped before recording the spawned runtime identity. No replacement was started.', 'Inspect the adapter and native processes on this host before manually recovering the tab.');
    if (this.required(panelId).conversation.provider === 'codex') {
      const runtime = this.codex.get(panelId);
      if (mode === 'chat' && runtime) { await runtime.release(); this.codex.delete(panelId); return; }
      const saved = this.required(panelId);
      if (mode === 'terminal' && saved.launch.codexSocketPath) { await this.native?.destroy(panelId); return; }
      const tracker = new ArchiveProcessTracker(saved.processes[mode], identities => panelManager.commitAgentChat(panelId, { ...this.required(panelId), processes: { ...this.required(panelId).processes, [mode]: structuredClone(identities) } }));
      await tracker.refresh();
      if (mode === 'terminal') await this.native?.destroy(panelId);
      await tracker.terminateSurvivors();
      await tracker.verifyExited(5000);
      return;
    }
    if (mode === 'chat') {
      const adapter = this.adapters.get(panelId);
      if (adapter) { await adapter.session.cancel(); await adapter.release(); this.adapters.delete(panelId); }
      else {
        const saved = this.required(panelId);
        const tracker = new ArchiveProcessTracker(saved.processes.chat, identities => panelManager.commitAgentChat(panelId, { ...this.required(panelId), processes: { ...this.required(panelId).processes, chat: structuredClone(identities) } }));
        await tracker.refresh();
        await tracker.verifyExited();
      }
      return;
    }
    const saved = this.required(panelId);
    const tracker = this.trackers.get(panelId) ?? new ArchiveProcessTracker(saved.processes.terminal, identities => panelManager.commitAgentChat(panelId, { ...this.required(panelId), processes: { ...this.required(panelId).processes, terminal: structuredClone(identities) } }));
    await tracker.refresh();
    const table = await readArchiveProcesses();
    const alive = saved.processes.terminal.some(identity => table.some(current => current.pid === identity.pid && current.started === identity.started && !current.exited));
    const journal = this.journals.get(panelId);
    if (alive && journal && this.native?.pid(panelId)) {
      if (journal.checkpoint().ready) {
        this.native.writeControl(panelId, '/exit\r');
        const deadline = Date.now() + 1500;
        while (!journal.ended() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      } else {
        // Never type /exit into a running tool or an unfinished prompt. The
        // tracked process lifetimes, rather than terminal appearance, fence exit.
        this.native.writeControl(panelId, '\x03');
      }
      await tracker.refresh();
      await this.native.destroy(panelId);
      await tracker.terminateSurvivors();
    }
    await this.stopObserving(panelId);
    await tracker.verifyExited(5000);
    this.trackers.delete(panelId);
    this.journals.delete(panelId);
  }

  private async acquire(record: ConversationRecord, mode: AgentInterface, options?: { fork: boolean }): Promise<{ nativeSessionId: string; historyVerified: boolean; forked?: boolean; transferNotice?: string }> {
    const saved = this.required(record.panelId);
    if (record.provider === 'codex') {
      if (mode === 'terminal') {
        this.acquiring.add(record.panelId);
        try { await this.native!.initialize(record.panelId, saved.launch.cwd, this.updateOperations.get(record.panelId)); }
        finally { this.acquiring.delete(record.panelId); }
      } else {
        const runtime = this.codex.get(record.panelId) ?? await this.startCodex(record);
        await runtime.session.load({ sessionId: record.nativeSessionId, cwd: saved.launch.cwd, mcpServers: [] });
      }
      await this.codex.get(record.panelId)?.session.verifyIdentity(record.nativeSessionId);
      if (!this.codex.has(record.panelId)) throw new PaneError('CHAT_RECOVERY_FAILED', 'Codex recovery did not attach its saved conversation.', 'Inspect the stopped tab before retrying.');
      return { nativeSessionId: record.nativeSessionId, historyVerified: true };
    }
    let forked = false;
    let transferNotice: string | undefined;
    if (mode === 'terminal') {
      this.acquiring.add(record.panelId);
      try {
        await this.native!.initialize(record.panelId, saved.launch.cwd, this.updateOperations.get(record.panelId));
        const deadline = Date.now() + 30_000;
        while (!this.journals.get(record.panelId)?.resumed() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (!this.journals.get(record.panelId)?.resumed()) throw new PaneError('CHAT_NATIVE_RESUME_UNCONFIRMED', 'The native CLI did not acknowledge the exact resumed conversation.', 'Leave the tab stopped and inspect recovery.');
      } finally { this.acquiring.delete(record.panelId); }
    } else {
      let runtime = this.adapters.get(record.panelId) ?? await this.startAdapter(record);
      const journalFile = path.join(path.dirname(saved.launch.settingsFile), `acp-${randomUUID()}.jsonl`);
      const settings = nativeChatHookSettings(journalFile);
      this.journals.set(record.panelId, new NativeHookJournal(journalFile, record.nativeSessionId));
      panelManager.commitAgentChat(record.panelId, { ...saved, launch: { ...saved.launch, journalFile } });
      const request = { sessionId: record.nativeSessionId, cwd: saved.launch.cwd, mcpServers: [], _meta: { claudeCode: { options: {
        settings, strictMcpConfig: saved.launch.strictMcpConfig, additionalDirectories: saved.launch.additionalDirectories ?? [],
        effort: saved.launch.effort,
      } } } };
      let result;
      if (options?.fork) { result = await runtime.session.fork(request); forked = true; }
      else {
        try { result = await runtime.session.load(request, { allowIncompleteHistory: true }); }
        catch (error) {
          if (!options) throw error;
          // The original owner is already stopped. Verify the failed loader's
          // exit before asking a fresh adapter to copy provider-native history.
          await this.release(record.panelId, 'chat');
          runtime = await this.startAdapter(record);
          result = await runtime.session.fork(request);
          forked = true;
        }
      }
      transferNotice = runtime.session.historyNotice() ?? this.transcripts.get(record.panelId)?.error();
      if (saved.launch.effort) await runtime.session.configure('effort', saved.launch.effort);
      if (forked && saved.launch.model) await runtime.session.configure('model', saved.launch.model);
      const model = decodeOptionalBoundary(result.configOptions?.find(option => option.id === 'model')?.currentValue, boundary.string);
      if (model && !forked) panelManager.commitAgentChat(record.panelId, { ...this.required(record.panelId), launch: { ...this.required(record.panelId).launch, model: model === 'default' ? undefined : model } });
      if (saved.launch.permissionMode && result.modes?.currentModeId !== saved.launch.permissionMode) await runtime.session.configure('mode', saved.launch.permissionMode);
    }
    return { nativeSessionId: this.required(record.panelId).conversation.nativeSessionId, historyVerified: true, forked, transferNotice };
  }

  private captureConfiguration(panelId: string): void {
    const saved = this.required(panelId);
    const launch = { ...saved.launch };
    if (saved.conversation.active === 'terminal') {
      const config = this.journals.get(panelId)?.config();
      launch.permissionMode = config?.permissionMode ?? launch.permissionMode;
      launch.effort = config?.effort ?? launch.effort;
    } else if (saved.conversation.active === 'chat') {
      // ACP controls reflect idle configuration changes; a previous Stop hook
      // still describes the last turn and must not overwrite those choices.
      for (const option of this.adapters.get(panelId)?.session.controls() ?? []) {
        if (option.id === 'mode') launch.permissionMode = option.currentValue;
        if (option.id === 'model') launch.model = option.currentValue === 'default' ? undefined : option.currentValue;
        if (option.id === 'effort') launch.effort = option.currentValue === 'default' ? undefined : option.currentValue;
      }
    }
    panelManager.commitAgentChat(panelId, { ...saved, launch });
  }

  async identify(panelId: string, nativeId: string, socketPath: string): Promise<AgentChatView> {
    const launch = this.legacyCodex.get(panelId);
    const panel = panelManager.getPanel(panelId);
    const pid = this.native?.pid(panelId);
    if (!launch || !panel || !pid || this.record(panelId) || this.adopting.has(panelId)) throw new PaneError('CHAT_IDENTIFICATION_UNAVAILABLE', 'This tab is no longer waiting for conversation identification.', 'Refresh the tab actions.');
    socketPath = socketPath.trim().replace(/^unix:\/\//, '');
    nativeId = nativeId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(nativeId) || !path.isAbsolute(socketPath) || ['\r', '\n', String.fromCharCode(0)].some(character => socketPath.includes(character))) throw new PaneError('CHAT_IDENTIFICATION_INVALID', 'Enter the current Session ID and absolute server socket shown by Codex /status.', 'Run /status yourself when the native composer is ready; preserve any unsent draft.');
    this.adopting.add(panelId);
    const saved: AgentChatPanelState = {
      conversation: { panelId, workspaceId: panel.sessionId, provider: 'codex', nativeSessionId: '', active: 'terminal', preferred: 'terminal', generation: 1 },
      launch: { command: launch.profile.executable, cwd: launch.cwd, shellType: launch.shellType, executable: launch.executable, version: '', strictMcpConfig: false, journalFile: '', settingsFile: '', codexSocketPath: socketPath },
      processes: { terminal: [], chat: [] },
    };
    this.known.add(panelId);
    panelManager.commitAgentChat(panelId, saved);
    this.environments.set(panelId, launch.env);
    this.controller(panelId);
    try {
      const runtime = await this.startCodex(saved.conversation);
      await runtime.session.verifyLoaded(nativeId);
      if (this.native?.pid(panelId) !== pid) throw new PaneError('CHAT_NATIVE_OWNER_MISSING', 'The original native terminal exited during identification.', 'Refresh before identifying its replacement.');
      await runtime.session.load({ sessionId: nativeId, cwd: launch.cwd, mcpServers: [] });
      if (this.native?.pid(panelId) !== pid) throw new PaneError('CHAT_NATIVE_OWNER_MISSING', 'The original native terminal exited during identification.', 'Refresh before identifying its replacement.');
      runtime.session.setGeneration(1); this.transcripts.get(panelId)?.setGeneration(1);
      this.known.add(panelId);
      this.publish(panelId);
    } catch (error) {
      await this.codex.get(panelId)?.release(false);
      this.codex.delete(panelId); this.controllers.delete(panelId); this.transcripts.delete(panelId);
      panelManager.commitAgentChat(panelId, undefined); this.known.delete(panelId);
      throw error;
    } finally { this.adopting.delete(panelId); this.publish(panelId); }
    return this.view(panelId);
  }

  async switchTo(panelId: string, target: AgentInterface, generation: number): Promise<ConversationRecord> {
    this.captureConfiguration(panelId);
    const conversation = await this.controller(panelId).switchTo(target, generation);
    await getRuntimeConfigManager().updateConfig({ defaultAgentInterface: target });
    return conversation;
  }

  receipt(panelId: string, operationId: string): AgentChatReceipt | undefined {
    return structuredClone(this.required(panelId).receipts?.find(receipt => receipt.operationId === operationId));
  }

  send(panelId: string, request: AgentChatSend): AgentChatReceipt {
    const saved = this.required(panelId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ text: request.text, images: request.images ?? [] })).digest('hex');
    const previous = this.receipt(panelId, request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.generation !== request.generation) throw new PaneError('CHAT_OPERATION_CONFLICT', 'This operation ID was already used for different content. No new prompt was sent.', 'Query its receipt, then use a new operation ID for a different prompt.');
      return previous;
    }
    this.controller(panelId).assertWritable(request.generation);
    if (saved.conversation.active !== 'chat') throw new PaneError('CHAT_NOT_ACTIVE', 'Chat does not own this conversation. No prompt was sent.', 'Use the active Terminal or switch to Chat.');
    if (!request.operationId || request.operationId.length > 128 || (!request.text.trim() && !request.images?.length)) throw new PaneError('CHAT_PROMPT_INVALID', 'The prompt or operation ID is empty or invalid. Nothing was sent.', 'Enter a prompt and use a unique operation ID.');
    if (request.text.length + (request.images ?? []).reduce((sum, image) => sum + image.data.length, 0) > 8 * 1024 * 1024) throw new PaneError('CHAT_PROMPT_TOO_LARGE', 'The prompt exceeds the 8 MiB transport limit. Nothing was sent.', 'Use a smaller image or prompt.');
    const runtime = this.session(panelId);
    if (!runtime) throw new PaneError('CHAT_RECOVERY_REQUIRED', 'The Chat runtime is unavailable. No prompt was sent.', 'Recover the exact saved conversation.');
    if (request.images?.length && (!runtime.supportsImages() || request.images.some(image => !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)))) throw new PaneError('CHAT_IMAGE_UNSUPPORTED', 'The adapter cannot accept these image attachments. Nothing was sent.', 'Use a supported PNG, JPEG, WebP or GIF image or send text.');
    if (this.view(panelId, false).running) throw new PaneError('CHAT_TURN_RUNNING', 'The agent is already working. No prompt was sent.', 'Wait for its turn or cancel it.');
    const receipts = (saved.receipts ?? []).filter(entry => entry.generation === request.generation);
    if (receipts.length >= 1024) throw new PaneError('CHAT_RECEIPTS_FULL', 'This runtime has reached its durable receipt limit. No prompt was sent.', 'Switch to Terminal and back at a checkpoint to begin a new runtime generation.');
    const receipt: AgentChatReceipt = { operationId: request.operationId, generation: request.generation, fingerprint, state: 'accepted' };
    panelManager.commitAgentChat(panelId, { ...saved, receipts: [...receipts, receipt] });
    const projection = this.transcripts.get(panelId);
    projection?.endTurn();
    const userContent = [
      ...(request.text ? [{ type: 'text' as const, text: request.text }] : []),
      ...(request.images ?? []).map(image => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data })),
    ];
    // Codex emits the provider's authoritative user item; adding a local item
    // as well would duplicate the same request when that notification arrives.
    for (const content of this.codex.has(panelId) ? [] : userContent) {
      const event = projection?.accept({ sessionUpdate: 'user_message_chunk', messageId: `user:${request.operationId}`, content });
      if (event && !projection?.error()) getPaneEventSink().send('agent-chat:event', event);
    }
    const finish = (state: 'completed' | 'failed', error?: string) => {
      const current = this.record(panelId);
      if (!current) return;
      panelManager.commitAgentChat(panelId, { ...current, receipts: current.receipts?.map(entry => entry.operationId === receipt.operationId ? { ...entry, state, error } : entry) });
      this.transcripts.get(panelId)?.endTurn();
      this.publish(panelId);
    };
    void runtime.prompt(userContent).then(() => finish('completed'), error => finish('failed', reasonOf(error)));
    return structuredClone(receipt);
  }

  async configure(panelId: string, generation: number, configId: string, value: string): Promise<void> {
    this.controller(panelId).assertWritable(generation);
    const session = this.session(panelId);
    if (!session || this.required(panelId).conversation.active !== 'chat') throw new PaneError('CHAT_NOT_ACTIVE', 'Chat does not own this conversation. Nothing changed.', 'Use the active interface.');
    await session.configure(configId, value);
    const saved = this.required(panelId);
    const launch = { ...saved.launch };
    if (configId === 'mode') launch.permissionMode = value;
    if (configId === 'model') launch.model = value === 'default' ? undefined : value;
    if (configId === 'effort') launch.effort = value === 'default' ? undefined : value;
    panelManager.commitAgentChat(panelId, { ...saved, launch });
    this.publish(panelId);
  }

  async cancel(panelId: string, generation: number): Promise<void> {
    this.controller(panelId).assertWritable(generation);
    const session = this.session(panelId);
    if (!session) throw new PaneError('CHAT_NOT_ACTIVE', 'There is no active Chat turn to cancel.', 'Use the active Terminal controls.');
    await session.cancel();
  }

  answerPermission(panelId: string, generation: number, requestId: string, optionId: string): void {
    this.controller(panelId).assertWritable(generation);
    const session = this.session(panelId);
    if (!session) throw new PaneError('CHAT_NOT_ACTIVE', 'The Chat runtime is no longer active. No answer was sent.', 'Refresh the conversation.');
    session.answer(requestId, generation, optionId);
  }

  manages(panelId: string): boolean { return !!this.record(panelId); }

  assertNativeInitialize(panelId: string): void {
    if (this.acquiring.has(panelId)) return;
    const saved = this.record(panelId);
    if (!saved) return;
    throw new PaneError('CHAT_RUNTIME_OWNED', 'This tab already has a conversation owner. No native runtime was started.', 'Open its current view or explicitly recover the saved conversation.');
  }

  activePanelIds(): string[] { return [...new Set([...this.adapters.keys(), ...this.codex.keys(), ...this.trackers.keys(), ...databaseService.getAgentChatPanelIds()])]; }

  processIds(): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const panelId of this.activePanelIds()) {
      const saved = this.record(panelId);
      if (!saved) continue;
      const ids = result.get(saved.conversation.workspaceId) ?? [];
      ids.push(...saved.processes.chat.map(identity => identity.pid));
      result.set(saved.conversation.workspaceId, ids);
    }
    return result;
  }

  async stopSession(workspaceId: string): Promise<void> {
    for (const panelId of this.activePanelIds()) if (this.record(panelId)?.conversation.workspaceId === workspaceId) await this.stop(panelId);
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(this.activePanelIds().map(panelId => this.stop(panelId)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async recover(panelId: string, mode: AgentInterface, generation: number): Promise<ConversationRecord> {
    if (!this.required(panelId).conversation.nativeSessionId) throw new PaneError('CHAT_IDENTITY_UNAVAILABLE', 'Startup did not return a conversation ID. No replacement conversation was created.', 'Inspect the provider session store and open the intended conversation explicitly in a separate Terminal tab.');
    const conversation = await this.controller(panelId).recover(mode, generation);
    await getRuntimeConfigManager().updateConfig({ defaultAgentInterface: mode });
    return conversation;
  }

  async restoreAfterUpdate(panelId: string, operationId: string): Promise<void> {
    this.updateOperations.set(panelId, operationId);
    try { await this.recover(panelId, 'terminal', this.required(panelId).conversation.generation); }
    finally { this.updateOperations.delete(panelId); }
  }

  verifyNativeResume(panelId: string, nativeId: string) {
    const record = this.required(panelId).conversation;
    const pid = this.native?.pid(panelId);
    if (!pid || record.active !== 'terminal' || record.nativeSessionId !== nativeId || !this.journals.get(panelId)?.resumed()) throw new PaneError('CHAT_NATIVE_RESUME_UNCONFIRMED', 'The native runtime did not confirm the exact saved conversation.', 'Inspect this tab before resuming it again.');
    return { pid };
  }

  async stop(panelId: string): Promise<void> {
    if (!this.record(panelId)) return;
    return this.controller(panelId).stop(() => this.stopOwned(panelId));
  }

  private async stopOwned(panelId: string): Promise<void> {
    const saved = this.required(panelId);
    if (saved.processes.unverifiedSpawn) throw new PaneError('CHAT_SPAWN_UNVERIFIED', 'The runtime identity was not recorded before interruption. Stop cannot safely target an unknown process.', 'Inspect the native and adapter processes on the workspace host.');
    await this.session(panelId)?.cancel();
    if (this.adapters.has(panelId) || this.codex.has(panelId)) await this.release(panelId, 'chat');
    else {
      const chat = new ArchiveProcessTracker(saved.processes.chat, identities => panelManager.commitAgentChat(panelId, { ...this.required(panelId), processes: { ...this.required(panelId).processes, chat: structuredClone(identities) } }));
      await chat.refresh();
      await chat.terminateSurvivors();
      await chat.verifyExited(5000);
    }
    await this.stopObserving(panelId);
    if (saved.launch.codexSocketPath) { await this.native?.destroy(panelId); this.trackers.delete(panelId); return; }
    const tracker = this.trackers.get(panelId) ?? new ArchiveProcessTracker(saved.processes.terminal, identities => panelManager.commitAgentChat(panelId, { ...this.required(panelId), processes: { ...this.required(panelId).processes, terminal: structuredClone(identities) } }));
    await tracker.refresh();
    await this.native?.destroy(panelId);
    await tracker.terminateSurvivors();
    await tracker.verifyExited(5000);
    this.trackers.delete(panelId);
    this.journals.delete(panelId);
  }
}

export const agentChatManager = new AgentChatManager();
