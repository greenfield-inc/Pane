// Isolated Electron client and loopback host using the production remote transport.
const { app, BrowserWindow, ipcMain, session } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const dist = path.resolve(__dirname, '../../main/dist');
const { PaneCommandRegistry } = require(`${dist}/main/src/daemon/commandRegistry.js`);
const { PaneRemoteHttpApiServer } = require(`${dist}/main/src/daemon/httpApiServer.js`);
const { hashRemoteDaemonToken } = require(`${dist}/main/src/daemon/auth.js`);
const { createDefaultRemoteDaemonConfig } = require(`${dist}/shared/types/remoteDaemon.js`);
const { readBrowserPanelFile } = require(`${dist}/main/src/services/browserPanelFiles.js`);
const { panelManager } = require(`${dist}/main/src/services/panelManager.js`);
const { databaseService } = require(`${dist}/main/src/services/database.js`);
const { prepareRemoteBrowserFiles } = require(`${dist}/main/src/daemon/client/remoteBrowserFiles.js`);
const { remotePaneClientController } = require(`${dist}/main/src/daemon/client/remotePaneClient.js`);
app.setPath('userData', path.join(process.env.PANE_DIR, 'electron'));

app.whenReady().then(async () => {
  const root = process.env.PANE_DIR;
  const bundle = path.join(root, 'Preview bundle');
  await fs.mkdir(path.join(bundle, 'nested'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'index.html'), '<title>Host bundle</title><link rel="stylesheet" href="theme.css"><main><p>REMOTE FILE PREVIEW</p><h1>Rendered from the host</h1><img src="mark.svg"><p>HTML, CSS and this image arrived through the authenticated Pane connection.</p><a href="nested/next.html">Next page</a></main>');
  await fs.writeFile(path.join(bundle, 'theme.css'), 'body{background:#eef5f0;color:#123d2b;font:20px system-ui;padding:60px}main{max-width:760px}h1{font-size:44px}img{width:100px}a{color:#145c39}');
  await fs.writeFile(path.join(bundle, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" rx="12" fill="#287d50"/></svg>');
  await fs.writeFile(path.join(bundle, 'nested/next.html'), '<h1>Sibling navigation works</h1><a href="../index.html">Back to entry</a>');
  await fs.writeFile(path.join(root, 'private.txt'), 'Must not be served');
  databaseService.createSession({ id: 'test-pane', name: 'Preview', initial_prompt: '', worktree_name: 'preview', worktree_path: root, tool_type: 'none' });
  const panel = await panelManager.createPanel({
    id: 'remote-preview', sessionId: 'test-pane', type: 'browser', title: 'index.html',
    initialState: { customState: { currentUrl: pathToFileURL(path.join(bundle, 'index.html')).href } },
  });
  const requests = [];
  const persisted = [];
  const localBundle = path.join(root, 'Local bundle');
  await fs.cp(bundle, localBundle, { recursive: true });
  const localEntry = path.join(localBundle, 'index.html');
  await fs.writeFile(localEntry, (await fs.readFile(localEntry, 'utf8')).replace('Rendered from the host', 'Rendered from local disk'));
  let localPanel = { ...panel, state: { ...panel.state, customState: { currentUrl: pathToFileURL(localEntry).href } } };
  let remoteMode = true;
  const registry = new PaneCommandRegistry();
  registry.register('panels:read-browser-file', (panelId, url) => {
    requests.push(url);
    return readBrowserPanelFile(panelManager.getPanel(panelId), url);
  });
  registry.register('panels:create', request => panelManager.createPanel(request));
  registry.register('panels:update', (id, updates) => panelManager.updatePanel(id, updates));
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  config.host.clients = [{ id: 'test-client', label: 'Test client', createdAt: new Date().toISOString(), tokenHash: hashRemoteDaemonToken('test-only-token') }];
  const host = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) });
  await host.start();
  const address = host.getAddress();
  ipcMain.handle('preview-test:host-url', () => `http://127.0.0.1:${address.port}/health`);
  await remotePaneClientController.activateProfile({ id: 'test-host', label: 'Test host', baseUrl: `http://127.0.0.1:${address.port}`, token: 'test-only-token', transport: 'http+sse' });
  ipcMain.handle('preview-test:panel', () => remoteMode ? panel : localPanel);
  ipcMain.handle('preview-test:requests', () => ({ requests, persisted }));
  ipcMain.handle('preview-test:disconnect', async () => { await remotePaneClientController.switchToLocalMode(); remoteMode = false; });
  ipcMain.handle('preview-test:resync', async (_event, remote) => {
    if (remote) await remotePaneClientController.activateProfile({ id: 'test-host', label: 'Test host', baseUrl: `http://127.0.0.1:${address.port}`, token: 'test-only-token', transport: 'http+sse' });
    remoteMode = remote;
    window.webContents.send('remote-daemon:resync-requested', { hostChanged: true });
  });
  ipcMain.handle('preview-test:host-http', async () => {
    const url = `http://127.0.0.1:${address.port}/health`;
    await session.fromPartition('persist:project-test-pane').cookies.set({ url, name: 'project-session', value: 'available' });
    await panelManager.updatePanel(panel.id, { state: { customState: { currentUrl: url } } });
    const updated = panelManager.getPanel(panel.id);
    await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('test-panel-update', { detail: ${JSON.stringify(updated)} }))`);
  });
  ipcMain.handle('preview-test:remote-command', (_event, channel, args) => remotePaneClientController.invoke(channel, args, async () => null));
  ipcMain.handle('browser-panel:prepare-file', (_event, panelId) => prepareRemoteBrowserFiles(panelId));
  ipcMain.handle('browser-panel:register-webview', () => ({ success: true }));
  ipcMain.handle('browser-panel:close-devtools', () => ({ success: true }));
  ipcMain.handle('panels:update', async (_event, ...args) => {
    persisted.push(args);
    if (remoteMode) await panelManager.updatePanel(...args);
    else localPanel = { ...localPanel, state: { ...localPanel.state, ...args[1].state } };
    const updated = remoteMode ? panelManager.getPanel(panel.id) : localPanel;
    await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('test-panel-update', { detail: ${JSON.stringify(updated)} }))`);
    return { success: true };
  });
  const window = new BrowserWindow({
    show: false, width: 1100, height: 780,
    webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'remote-browser-preload.cjs') },
  });
  await window.loadURL('about:blank');
});
