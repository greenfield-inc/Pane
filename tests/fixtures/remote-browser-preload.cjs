const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  events: {
    onListeningPortsChanged: () => () => {},
    onRemoteDaemonResyncRequested: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('remote-daemon:resync-requested', listener);
      return () => ipcRenderer.removeListener('remote-daemon:resync-requested', listener);
    },
  },
  remoteDaemon: {
    getConnectionState: async () => ({ success: true, data: await ipcRenderer.invoke('preview-test:connection-state') }),
    getHostState: () => new Promise(() => {}),
    onConnectionStateChanged: () => () => {},
    onHostStateChanged: () => () => {},
  },
});
ipcRenderer.on('browser-panel:file-refused', (_event, detail) => window.dispatchEvent(new CustomEvent('browser-panel:file-refused', { detail })));
contextBridge.exposeInMainWorld('electron', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });
