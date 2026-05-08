const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadAll:    ()      => ipcRenderer.invoke('db-load-all'),
  saveAll:    (data)  => ipcRenderer.invoke('db-save-all', data),
  clearAll:   ()      => ipcRenderer.invoke('db-clear-all'),
  exportFile: (content, filename) => ipcRenderer.invoke('db-export', content, filename),
  importFile: ()      => ipcRenderer.invoke('db-import'),
});
