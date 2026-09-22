const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
