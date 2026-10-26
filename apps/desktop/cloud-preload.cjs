const { contextBridge, ipcRenderer } = require('electron');
// Remote content can only reveal native settings; it cannot grant permissions,
// inspect configuration, read credentials, or execute local operations.
contextBridge.exposeInMainWorld('customCloudBotDesktop', Object.freeze({
  openSettings: () => ipcRenderer.invoke('desktop:open-settings')
}));
