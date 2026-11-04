const { contextBridge, ipcRenderer } = require('electron');
const noop = () => () => {};
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  events: { onListeningPortsChanged: noop, onRemoteDaemonResyncRequested: noop },
  remoteDaemon: {
    getConnectionState: async () => ({ success: true, data: { mode: 'local', status: 'local', activeProfileId: null, activeProfileLabel: null, activeBaseUrl: null, lastError: null, lastSeenAt: null } }),
    getHostState: () => new Promise(() => {}),
    onConnectionStateChanged: noop,
    onHostStateChanged: noop,
  },
});
contextBridge.exposeInMainWorld('electron', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });
