const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });
contextBridge.exposeInMainWorld('electron', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });
