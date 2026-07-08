const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__fcTerm', {
  onInit: (cb) => ipcRenderer.on('fc-term-init', (_e, m) => cb(m)),
  onData: (cb) => ipcRenderer.on('fc-term-data', (_e, m) => cb(m)),
  onExit: (cb) => ipcRenderer.on('fc-term-exit', (_e, m) => cb(m)),
  create: (cwd) => ipcRenderer.invoke('fc-term-create', { cwd }),
  write: (id, data) => ipcRenderer.send('fc-term-write', { id, data }),
  kill: (id) => ipcRenderer.send('fc-term-kill', { id }),
});
