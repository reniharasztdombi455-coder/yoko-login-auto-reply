const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('speechLibraryApi', {
  getLibrary: () => ipcRenderer.invoke('speech-library-get'),
  saveLibrary: library => ipcRenderer.invoke('speech-library-save', library || {}),
  pickImages: () => ipcRenderer.invoke('speech-library-pick-images'),
  getTarget: () => ipcRenderer.invoke('speech-library-target'),
  sendMessage: payload => ipcRenderer.invoke('speech-library-send', payload || {}),
  onRefreshTarget: callback => {
    if (typeof callback !== 'function') return () => {};
    const handler = () => callback();
    ipcRenderer.on('speech-library-refresh-target', handler);
    return () => ipcRenderer.removeListener('speech-library-refresh-target', handler);
  }
});
