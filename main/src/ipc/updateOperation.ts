import { agentChatManager } from '../services/agentChat/agentChatManager';
import { UpdatePanelRestorer } from '../services/updateRestoration';
import { getPaneEventSink } from '../core/runtime';
import { beginUpdateShutdown } from '../services/updateShutdown';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppServices } from './types';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { getAppDirectory } from '../utils/appDirectory';
import { remoteHostRuntimeStateStore } from '../daemon/remoteHostRuntimeState';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { checkpointUpdatePanel, checkpointSchema } from '../services/updateContinuation';
import { readUpdateJournal, writeUpdateJson } from '../../../packages/runpane/src/updateOperation';
import { getAutoUpdater } from '../autoUpdater';
import { getUpdateCapabilities } from '../utils/updateCapabilities';
import { MAC_UPDATE_COMMAND } from './updater';

const bootId = randomUUID();
const requestSchema = boundary.object({ id: boundary.nonEmptyString, bootId: boundary.nonEmptyString });


export function registerUpdateOperationHandlers(services: AppServices, registry: PaneCommandRegistry): void {
  const panels = () => services.databaseService.getAllSessions(undefined, { includeHidden: true }).flatMap(session => panelManager.getPanelsForSession(session.id)).filter(panel => panel.type === 'terminal');
  const directory = (id: string) => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new PaneError('ERR_UPDATE_ID', 'Invalid update operation. Nothing was changed.', 'Use the ID returned by runpane update.');
    return path.join(getAppDirectory(), 'updates', id);
  };
  const assertOwner = (value: PaneCommandValue) => {
    if (isRemotePaneCommand()) throw new PaneError('ERR_UPDATE_LOCAL_ONLY', 'Update control requires a local command on this host. Nothing was changed.', 'Run runpane update through the owning workspace shell.');
    const request = decodeBoundary(value, requestSchema);
    if (request.bootId !== bootId) throw new PaneError('ERR_UPDATE_HOST_CHANGED', 'Pane restarted after preflight. Nothing was changed.', 'Run update again against the current host.');
    if (fs.existsSync(path.join(directory(request.id), 'canceled.json'))) throw new PaneError('ERR_UPDATE_CANCELED', 'The update operation was canceled. Pane remains running.', 'Start a new update operation.');
    const journal = readUpdateJournal(path.join(directory(request.id), 'status.json'));
    if (!journal.helperPid || journal.helperPid === process.pid) throw new PaneError('ERR_UPDATE_HELPER_NOT_READY', 'The independent helper has not acknowledged startup. Pane remains running.', 'Inspect the update operation status and supervisor log.');
    process.kill(journal.helperPid, 0);
    return request;
  };
  registry.register('runpane:update:host', async () => {
    const all = panels();
    const remote = (services.configManager.getConfig().remoteDaemon ?? createDefaultRemoteDaemonConfig()).host;
    let remoteHealthy = !remote.config.enabled;
    if (remote.config.enabled && remoteHostRuntimeStateStore.getState().status === 'live') {
      try {
        const listenHost = remote.config.listenHost.includes(':') ? `[${remote.config.listenHost}]` : remote.config.listenHost;
        const base = `http://${listenHost}:${remote.config.listenPort}`;
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        const auth = await fetch(`${base}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'panels:list', args: ['update-auth-probe'] }), signal: AbortSignal.timeout(2000) });
        remoteHealthy = health.ok && (remote.config.pairingRequired ? auth.status === 401 || auth.status === 403 : auth.ok);
        await Promise.all([health.body?.cancel(), auth.body?.cancel()]);
      } catch { /* A listening/authentication failure keeps the health gate closed. */ }
    }
    return { protocol: 1, machine: os.hostname(), bootId, pid: process.pid, executable: process.env.APPIMAGE ?? process.execPath, version: services.app.getVersion(), paneDir: getAppDirectory(), userData: services.app.getPath('userData'), packaged: services.app.isPackaged,
      remoteEnabled: remote.config.enabled, remoteHealthy, endpointFingerprint: createHash('sha256').update(JSON.stringify({ config: remote.config, baseUrl: remote.access?.baseUrl, clients: remote.clients.map(client => ({ id: client.id, tokenHash: client.tokenHash })) })).digest('hex'),
      active: all.filter(panel => terminalPanelManager.getAgentStatus(panel.id) === 'working').length,
      blocked: all.filter(panel => terminalPanelManager.getAgentStatus(panel.id) === 'blocked').length,
      idle: all.filter(panel => terminalPanelManager.getAgentStatus(panel.id) !== 'working' && terminalPanelManager.getAgentStatus(panel.id) !== 'blocked').length };
  });
  registry.register('runpane:update:progress', (value: PaneCommandValue) => {
    const { id } = decodeBoundary(value, boundary.object({ id: boundary.nonEmptyString }));
    const journal = readUpdateJournal(path.join(directory(id), 'status.json'));
    return { id, phase: journal.phase, appUpdated: journal.appUpdated, cliUpdated: journal.cliUpdated, hostReachable: journal.hostReachable, updatedAt: journal.updatedAt };
  });
  registry.register('runpane:update:checkpoint', async (value: PaneCommandValue) => {
    const request = assertOwner(value);
    if (services.archiveProgressManager?.hasActiveTasks()) throw new PaneError('ERR_UPDATE_BUSY', 'Worktree removal is still running. Pane remains open.', 'Wait for archive tasks to finish, then retry the update.');
    const file = path.join(directory(request.id), 'checkpoint.json');
    if (fs.existsSync(file)) return decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), checkpointSchema);
    await terminalPanelManager.saveAllTerminalStates();
    const checkpoint = { bootId, panels: panels().map(panel => {
      // SAFETY: checkpoint enumeration and restoration only accept terminal panels.
      const state = panel.state.customState as TerminalPanelState;
      return { panelId: panel.id, sessionId: panel.sessionId, ...checkpointUpdatePanel(state ?? {}, terminalPanelManager.getAgentStatus(panel.id), services.sessionManager.getSession(panel.sessionId)?.worktreePath) };
    }) };
    writeUpdateJson(file, checkpoint);
    const intent = { protocol: 1, id: request.id, bootId, machine: os.hostname(), phase: 'checkpoint', timestamp: new Date().toISOString() };
    writeUpdateJson(path.join(directory(request.id), 'intent.json'), intent);
    getPaneEventSink().send('remote:update-intent', intent);
    return checkpoint;
  });
  registry.register('runpane:update:stop', async (value: PaneCommandValue) => {
    const request = assertOwner(value);
    const checkpoint = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory(request.id), 'checkpoint.json'), 'utf8')), checkpointSchema);
    await registry.quiesceForUpdate();
    try {
    const latestPanels = panels().map(panel => {
      // SAFETY: enumeration includes terminal panels only.
      const state = panel.state.customState as TerminalPanelState;
      const screen = terminalPanelManager.getTerminalSnapshot(panel.id)?.screenText;
      return { panelId: panel.id, sessionId: panel.sessionId, ...checkpointUpdatePanel({ ...state, screenText: screen ?? state.screenText }, terminalPanelManager.getAgentStatus(panel.id), services.sessionManager.getSession(panel.sessionId)?.worktreePath) };
    });
    writeUpdateJson(path.join(directory(request.id), 'checkpoint.json'), { ...checkpoint, panels: latestPanels });
    for (const item of latestPanels) {
      const panel = panelManager.getPanel(item.panelId);
      if (!panel) continue;
      // SAFETY: checkpoint enumeration and restoration only accept terminal panels.
      const state = panel.state.customState as TerminalPanelState;
      await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: { ...state, updateResumeHold: request.id, initialInput: undefined, initialInputFile: undefined } } });
    }
    beginUpdateShutdown(directory(request.id), request.id, bootId);
    setTimeout(() => services.app.quit(), 100);
    return { accepted: true };
    } catch (error) { registry.cancelUpdateQuiescence(); throw error; }
  });
  const restorer = new UpdatePanelRestorer(directory, bootId, {
    getPanel: id => panelManager.getPanel(id),
    updatePanel: async (id, update) => { await panelManager.updatePanel(id, update); },
    isInitialized: id => terminalPanelManager.isAgentRuntimeInitialized(id),
    initialize: async (panel, cwd, operationId) => {
      if (agentChatManager.manages(panel.id)) return agentChatManager.restoreAfterUpdate(panel.id, operationId);
      const context = services.sessionManager.getProjectContext(panel.sessionId)?.commandRunner.wslContext;
      await terminalPanelManager.initializeTerminal(panel, cwd, context, 1, undefined, operationId);
    },
    verify: async (panelId, resumeId) => agentChatManager.manages(panelId) ? agentChatManager.verifyNativeResume(panelId, resumeId) : terminalPanelManager.verifyUpdateResume(panelId, resumeId),
  });
  // runpane update hands off here when this host cannot run the independent
  // update (no standalone Node, an unwritable install, the bundled CLI). It is
  // the Settings Update button: download, then quit and install.
  registry.register('runpane:update:in-app', async () => {
    if (isRemotePaneCommand()) throw new PaneError('ERR_UPDATE_LOCAL_ONLY', 'In-app update requires a local command on this host. Nothing was changed.', 'Run runpane update through the owning workspace shell.');
    const current = services.app.getVersion();
    if (!services.app.isPackaged) throw new PaneError('ERR_UPDATE_IN_APP_UNAVAILABLE', `In-app update is unsupported in a development build (Pane ${current}). Nothing was changed.`, 'Use a packaged Pane installation.');
    const capabilities = await getUpdateCapabilities({ platform: process.platform, isPackaged: true, executablePath: process.execPath });
    if (capabilities.mode === 'manual') throw new PaneError('ERR_UPDATE_IN_APP_UNAVAILABLE', `In-app update is unsupported for this copy of Pane ${current} (${capabilities.reason}). Nothing was changed.`, `Run \`${MAC_UPDATE_COMMAND}\` in a terminal.`);
    const updater = getAutoUpdater();
    const check = await updater.checkForUpdates();
    if (!check?.isUpdateAvailable) return { state: 'current', fromVersion: current, version: current };
    await updater.downloadUpdate();
    // Reply before quitting so the CLI hears that the install started.
    setTimeout(() => updater.quitAndInstall(false, true), 1000);
    return { state: 'installing', fromVersion: current, version: check.updateInfo.version };
  });
  registry.register('runpane:update:restore', async (value: PaneCommandValue) => {
    if (isRemotePaneCommand()) throw new PaneError('ERR_UPDATE_LOCAL_ONLY', 'Update restoration requires a local command.', 'Run it on the owning machine.');
    const request = decodeBoundary(value, boundary.object({ id: boundary.nonEmptyString }));
    return restorer.restore(request.id);
  });
}
