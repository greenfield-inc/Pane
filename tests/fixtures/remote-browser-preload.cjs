const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  events: {
    onRemoteDaemonResyncRequested: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('remote-daemon:resync-requested', listener);
      return () => ipcRenderer.removeListener('remote-daemon:resync-requested', listener);
    },
  },
});
contextBridge.exposeInMainWorld('electron', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });
