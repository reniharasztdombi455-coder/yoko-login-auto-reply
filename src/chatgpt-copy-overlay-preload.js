const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('copyApi', {
  state: () => ipcRenderer.invoke('chatgpt-copy-latest-state'),
  paste: () => ipcRenderer.invoke('chatgpt-paste-clipboard-to-composer'),
  clear: () => ipcRenderer.invoke('chatgpt-clear-composer'),
  copy: () => ipcRenderer.invoke('chatgpt-copy-latest-reply'),
  send: () => ipcRenderer.invoke('chatgpt-send-latest-reply')
});
