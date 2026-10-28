const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('yokoLogin', {
  login: payload => ipcRenderer.invoke('app-auth-login', payload || {}),
  rememberedLogin: () => ipcRenderer.invoke('app-auth-remember-get'),
  saveRememberedLogin: payload => ipcRenderer.invoke('app-auth-remember-save', payload || {})
});
