import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { getAppDirectory } from '../utils/appDirectory';
import { panelManager } from '../services/panelManager';
import { isProcessAlive, readProcessTable } from '../utils/processTree';
import { scanSessions, isSelectable, type ScanOutcome } from '../services/sessionImport/scan';
import { placeSessions, type PlacementPort, type TabCheck } from '../services/sessionImport/place';
import { recordedSessionKeys } from '../services/sessionImport/record';
import { SOURCE_READERS } from '../services/sessionImport/sources';
import { claudeConfigDir, codexHome } from '../services/sessionImport/sources/common';
import type { ReaderContext } from '../services/sessionImport/sources/types';
import {
  SESSION_IMPORT_HOME_RETIRED_PREFERENCE,
  type ImportSessionResult,
  type SessionImportProgress,
  type SessionImportRunResult,
  type SessionImportScan,
} from '../../../shared/types/sessionImport';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';
import type {
  RunpanePaneAdoptResult,
  RunpanePanelCreateResult,
  RunpanePanelWaitResult,
  RunpaneRepoAddResult,
} from '../../../shared/types/runpaneOrchestration';

const SESSION_IMPORT_CHANNELS = ['session-import:home', 'session-import:scan', 'session-import:run', 'session-import:progress'] as const;
const LISTED_MS = 30 * 24 * 60 * 60 * 1000;
const READY_TIMEOUT_MS = 90_000;
/** Home shows the card only while the person has fewer Panes than this. */
const HOME_PANE_LIMIT = 2;

/**
 * "Bring your sessions into Pane": scans other agent tools' stores on the
 * computer that runs the agents and brings chosen sessions in as Panes.
 */
export function registerSessionImportHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  const { databaseService, sessionManager } = services;
  let latest: Promise<ScanOutcome> | undefined;
  let progress: SessionImportProgress = { running: false, done: {}, total: {} };

  const homeEligible = (): boolean =>
    databaseService.getUserPreference(SESSION_IMPORT_HOME_RETIRED_PREFERENCE) !== 'true'
    && databaseService.getAllSessions().length < HOME_PANE_LIMIT;

  const alreadyInPane = (): Set<string> => {
    const keys = recordedSessionKeys(getAppDirectory());
    for (const session of databaseService.getAllSessions()) {
      for (const panel of panelManager.getPanelsForSession(session.id)) {
        // SAFETY: terminal panels persist TerminalPanelState as their custom state.
        const state = panel.state.customState as TerminalPanelState | undefined;
        if (state?.agentSessionId && state.agentType) keys.add(`${state.agentType}:${state.agentSessionId}`);
      }
    }
    return keys;
  };

  const excludedRoots = (): string[] => {
    const paneWorktrees = databaseService.getAllSessionsIncludingArchived({ includeHidden: true })
      .filter(session => session.worktree_ownership !== 'external' && !session.is_main_repo && session.worktree_path)
      .map(session => session.worktree_path);
    const temp = process.platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp'];
    return [os.tmpdir(), ...temp, getAppDirectory(), ...paneWorktrees];
  };

  const scan = (): Promise<ScanOutcome> => {
    const now = Date.now();
    let processes: Promise<string[]> | undefined;
    const context: ReaderContext = {
      env: process.env,
      home: os.homedir(),
      platform: process.platform,
      now,
      sinceMs: now - LISTED_MS,
      tempDir: os.tmpdir(),
      isPidAlive: isProcessAlive,
      processCommands: () => (processes ??= readProcessTable().then(rows => {
        // The table always holds Pane itself, so an empty one means it couldn't be read.
        if (rows.length === 0) {
          throw new PaneError('ERR_SESSION_IMPORT_PROCESSES', "Pane couldn't list running processes, so it can't tell which sessions are still running", 'Press Check again.');
        }
        return rows.map(row => row.executable);
      })),
    };
    latest = scanSessions({ context, readers: SOURCE_READERS, alreadyInPane: alreadyInPane(), excludedRoots: excludedRoots() });
    latest.catch(error => console.error('[SessionImport] Scan failed:', error));
    return latest;
  };

  const port: PlacementPort = {
    async addRepo(repoRoot) {
      // SAFETY: the registered runpane handler returns RunpaneRepoAddResult.
      const result = await commandRegistry.invoke('runpane:repos:add', [{ path: repoRoot }]) as RunpaneRepoAddResult;
      if (!result.repo) throw new Error(`Pane couldn't register ${repoRoot}`);
      return result.repo.id;
    },
    paneForCheckout(checkout) {
      const session = sessionManager.getAllSessions().find(candidate => !candidate.archived && samePath(candidate.worktreePath, checkout));
      return session ? { paneId: session.id, name: session.name } : undefined;
    },
    async adopt(repoId, checkout, name, agent, resume) {
      // SAFETY: the registered runpane handler returns RunpanePaneAdoptResult.
      const result = await commandRegistry.invoke('runpane:panes:adopt', [{
        repo: { id: repoId }, noFocus: true, source: 'agent',
        panes: [{ path: checkout, name, tool: { agent }, resume, launch: true }],
      }]) as RunpanePaneAdoptResult;
      const item = result.items[0];
      if (!item) throw new Error('Pane could not adopt the checkout');
      if ('error' in item) throw new Error(item.error.message);
      if (!item.paneId || !item.panelId) throw new Error('Pane adopted the checkout but returned no tab');
      return { paneId: item.paneId, panelId: item.panelId };
    },
    async addTab(paneId, agent, resume) {
      // SAFETY: the registered runpane handler returns RunpanePanelCreateResult.
      const result = await commandRegistry.invoke('runpane:panels:create', [{
        paneId, tool: { agent }, resume, noFocus: true, source: 'agent',
      }]) as RunpanePanelCreateResult;
      return { panelId: result.panelId };
    },
    storedResumeId(panelId) {
      // SAFETY: terminal panels persist TerminalPanelState as their custom state.
      const state = panelManager.getPanel(panelId)?.state.customState as TerminalPanelState | undefined;
      return state?.agentSessionId;
    },
    async waitReady(panelId) {
      // SAFETY: the registered runpane handler returns RunpanePanelWaitResult.
      const result = await commandRegistry.invoke('runpane:panels:wait', [{ panelId, condition: 'ready', timeoutMs: READY_TIMEOUT_MS }]) as RunpanePanelWaitResult;
      return toTabCheck(result);
    },
    async closeTab(panelId) {
      // SAFETY: the panels:delete handler answers with { success, error }.
      const result = await commandRegistry.invoke('panels:delete', [panelId]) as { success: boolean; error?: string };
      if (!result.success) throw new Error(result.error ?? 'the tab could not be closed');
    },
    async rollbackPane(paneId) {
      await sessionManager.archiveSession(paneId);
      databaseService.deleteArchivedSessionPermanently(paneId);
    },
  };

  commandRegistry.register('session-import:home', async (): Promise<SessionImportScan | null> => {
    if (!homeEligible()) return null;
    const { scan: result } = await (latest ?? scan());
    return result.sessions.some(session => session.preselected) ? result : null;
  });

  commandRegistry.register('session-import:scan', async (): Promise<SessionImportScan> => (await scan()).scan);

  commandRegistry.register('session-import:progress', (): SessionImportProgress => progress);

  commandRegistry.register('session-import:run', async (request: PaneCommandValue): Promise<SessionImportRunResult> => {
    if (progress.running) {
      throw new PaneError(
        'ERR_SESSION_IMPORT_RUNNING',
        'Pane is already bringing sessions in, so this request was not started and nothing changed.',
        'Wait for the current import to finish, then open "Bring sessions into Pane" again.',
      );
    }
    const keys = new Set(decodeBoundary(request, boundary.array(boundary.string)));
    // Claim the run before the first await, so a second request can't start alongside it.
    progress = { running: true, done: {}, total: {} };
    try {
      // Rescan so a session that started running since the card was drawn is left alone.
      const fresh = await scan();
      const chosen = [...keys].flatMap(key => fresh.sessions.get(key) ?? []);
      const skipped: ImportSessionResult[] = chosen.filter(session => !isSelectable(session)).map(session => ({
        key: session.key, source: session.source, agent: session.agent, title: session.title,
        outcome: session.running === 'no' ? 'not continued' : 'skipped running',
        reason: session.alreadyInPane ? 'It is already in Pane.' : session.unavailable,
      }));
      const placeable = chosen.filter(isSelectable);
      for (const session of placeable) progress.total[session.source] = (progress.total[session.source] ?? 0) + 1;
      const result = await placeSessions({
        sessions: placeable,
        port,
        stores: { claudeConfigDir: claudeConfigDir({ env: process.env, home: os.homedir() }), codexHome: codexHome({ env: process.env, home: os.homedir() }) },
        paneDir: getAppDirectory(),
        onProgress: session => { progress.done[session.source] = (progress.done[session.source] ?? 0) + 1; },
      });
      return { ...result, results: [...result.results, ...skipped] };
    } finally {
      progress = { ...progress, running: false };
      latest = undefined;
    }
  });

  commandRegistry.bindChannels(ipcMain, SESSION_IMPORT_CHANNELS);

  // Start reading early so the Home card is usually ready before Home first paints.
  setImmediate(() => {
    if (homeEligible()) void scan().catch(() => undefined);
  });
}

function toTabCheck(result: RunpanePanelWaitResult): TabCheck {
  if (result.matched) return { state: 'ready' };
  if (result.blocked?.kind === 'first-run-dialog' && /trust|folder access|safety check/i.test(result.blocked.message)) return { state: 'trust' };
  // An agent that is up but slow keeps its tab; only one that exited or never appeared has failed.
  if (result.timedOut && result.reason?.code === 'agent-not-ready') return { state: 'starting' };
  const reason = (result.reason?.message ?? result.blocked?.message.split('\n')[0])?.replace(/[.\s]+$/u, '')
    ?? (result.timedOut ? `it wasn't ready after ${READY_TIMEOUT_MS / 1000} seconds` : 'it stopped before it was ready');
  return { state: 'failed', reason };
}

function samePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
