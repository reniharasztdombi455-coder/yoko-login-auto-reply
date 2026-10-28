const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('historyApi', {
  list: filters => ipcRenderer.invoke('chat-history-list', filters || {}),
  get: (conversationId, limit = 1200) => ipcRenderer.invoke('chat-history-get', conversationId, limit),
  captureCurrent: () => ipcRenderer.invoke('chat-history-capture-current'),
  onUpdated: callback => {
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on('chat-history-updated', handler);
    return () => ipcRenderer.removeListener('chat-history-updated', handler);
  }
});
