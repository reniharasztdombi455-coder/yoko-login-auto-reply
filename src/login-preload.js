const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('yokoLogin', {
  login: payload => ipcRenderer.invoke('app-auth-login', payload || {})
});
