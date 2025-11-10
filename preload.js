const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('padAPI', {
  onFileOpened(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on('pad:file-opened', listener);
    return () => ipcRenderer.removeListener('pad:file-opened', listener);
  },
});
