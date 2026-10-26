const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  status: () => ipcRenderer.invoke('desktop:status'),
  retryStorage: () => ipcRenderer.invoke('desktop:retry-storage'),
  configure: (settings) => ipcRenderer.invoke('desktop:configure', settings),
  chooseFolders: () => ipcRenderer.invoke('desktop:folders'),
  connect: (settings) => ipcRenderer.invoke('desktop:connect', settings),
  pause: () => ipcRenderer.invoke('desktop:pause'),
  revoke: () => ipcRenderer.invoke('desktop:revoke'),
  showApp: () => ipcRenderer.invoke('desktop:show-app'),
  showSettings: () => ipcRenderer.invoke('desktop:show-settings'),
  openPendingLink: () => ipcRenderer.invoke('desktop:external'),
  openPermissionSettings: (kind) => ipcRenderer.invoke('desktop:permission-settings', kind),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  }
}));
