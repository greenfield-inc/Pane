// Isolated Electron client for browser login persistence. Its browser profile
// lives under PANE_DIR, so it never reads or clears a real Pane profile.
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const dist = path.resolve(__dirname, '../../main/dist');
const { clearPaneBrowserData } = require(`${dist}/main/src/services/browserData.js`);
const { routeWebviewPopups } = require(`${dist}/main/src/services/webviewPopups.js`);
const { rejectWithPaneErrorText } = require(`${dist}/main/src/daemon/commandRegistry.js`);
app.setPath('userData', path.join(process.env.PANE_DIR, 'electron'));

const page = (body, script = '') => `<!doctype html><title>Login fixture</title><body style="font:20px system-ui;padding:32px;margin:0;min-height:100vh;box-sizing:border-box;background:#f6f7f4;color:#1d2a22">${body}<script>${script}</script></body>`;

const BASIC_CREDENTIALS = `Basic ${Buffer.from('pane:fixture-password').toString('base64')}`;

// One site on two origins (127.0.0.1 and localhost) so the popup is cross-origin.
function startSite() {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://fixture');
    const port = server.address().port;
    response.setHeader('Content-Type', 'text/html');
    if (pathname === '/login') {
      response.setHeader('Set-Cookie', 'pane_login=1; Max-Age=86400; Path=/');
      response.end(page('Signing in…', "localStorage.setItem('pane_login', '1'); location.replace('/');"));
    } else if (pathname === '/opener') {
      response.end(page('<button id="sign-in">Sign in with popup</button><p id="status">Waiting for popup</p>', `
        addEventListener('message', event => { if (event.data === 'popup-signed-in') document.getElementById('status').textContent = 'Popup completed'; });
        document.getElementById('sign-in').onclick = () => {
          if (!window.open('http://localhost:${port}/popup', 'sign-in', 'width=420,height=520')) document.getElementById('status').textContent = 'Popup blocked';
        };`));
    } else if (pathname === '/basic-api') {
      // HTTP Basic auth: the browser keeps these credentials in its auth cache, not in cookies or storage.
      response.setHeader('Cache-Control', 'no-store');
      if (request.headers.authorization === BASIC_CREDENTIALS) {
        response.end('authenticated');
      } else {
        response.statusCode = 401;
        response.setHeader('WWW-Authenticate', 'Basic realm="fixture"');
        response.end('unauthorized');
      }
    } else if (pathname === '/basic-login') {
      response.end(page('Signing in with a password…', `
        const request = new XMLHttpRequest();
        request.open('GET', '/basic-api', true, 'pane', 'fixture-password');
        request.onload = () => location.replace('/basic');
        request.send();`));
    } else if (pathname === '/basic') {
      response.end(page('<p id="status"></p>', `
        fetch('/basic-api', { cache: 'no-store' }).then(r => {
          document.getElementById('status').textContent = r.ok ? 'Password signed in' : 'Password signed out';
        });`));
    } else if (pathname === '/popup') {
      response.setHeader('Set-Cookie', 'pane_popup=1; Max-Age=86400; Path=/');
      response.end(page('Popup signed in', "window.opener.postMessage('popup-signed-in', '*');"));
    } else {
      response.end(page('<p id="status"></p><p id="detail"></p>', `
        const cookie = document.cookie.split('; ').includes('pane_login=1');
        const storage = localStorage.getItem('pane_login') === '1';
        document.getElementById('status').textContent = cookie && storage ? 'Signed in' : 'Signed out';
        document.getElementById('detail').textContent = 'cookie: ' + (cookie ? 'yes' : 'no') + ', localStorage: ' + (storage ? 'yes' : 'no') + ', cookies: ' + document.cookie;`));
    }
  });
  // localStorage is per origin, port included, so a relaunch reuses the first launch's port.
  const portFile = path.join(process.env.PANE_DIR, 'site-port');
  const port = fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf8')) : 0;
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(portFile, String(server.address().port));
    resolve(server.address().port);
  }));
}

app.whenReady().then(async () => {
  const port = await startSite();
  ipcMain.handle('auth-test:site', () => ({ site: `http://127.0.0.1:${port}`, popupOrigin: `http://localhost:${port}` }));
  ipcMain.handle('auth-test:window-count', () => BrowserWindow.getAllWindows().length);
  ipcMain.handle('auth-test:user-data', () => app.getPath('userData'));
  ipcMain.handle('browser-data:clear', () => rejectWithPaneErrorText(clearPaneBrowserData()));
  ipcMain.handle('browser-panel:prepare-file', () => ({ partition: null }));
  ipcMain.handle('browser-panel:register-webview', () => ({ success: true }));
  ipcMain.handle('browser-panel:close-devtools', () => ({ success: true }));
  ipcMain.handle('panels:update', () => ({ success: true }));
  ipcMain.handle('ports:list', () => ({ host: 'local', ports: [] }));
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'browser-auth-preload.cjs') },
  });
  window.webContents.on('did-attach-webview', (_event, contents) => {
    routeWebviewPopups(contents, { contextOf: () => undefined, openBrowserTab: () => undefined, openExternal: () => undefined });
  });
  await window.loadURL('about:blank');
});
