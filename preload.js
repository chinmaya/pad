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
  saveSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return Promise.resolve({ ok: false, error: 'Invalid snapshot' });
    }
    return ipcRenderer.invoke('pad:save-snapshot', snapshot);
  },
  updateAutoBackup() {
    return ipcRenderer.invoke('pad:update-auto-backup');
  },
  getBackupSettings() {
    return ipcRenderer.invoke('pad:get-backup-settings');
  },
});
