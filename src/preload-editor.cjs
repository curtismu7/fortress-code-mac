const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__fcEditor', {
  on: (cb) => ipcRenderer.on('fc-editor', (_e, m) => cb(m)),
  save: (path, content) => ipcRenderer.invoke('fc-editor-save', { path, content }),
});
