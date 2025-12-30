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
  onRestoreMerge(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on('pad:restore-merge', listener);
    return () => ipcRenderer.removeListener('pad:restore-merge', listener);
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
  recordTabEvent(payload) {
    if (!payload || typeof payload !== 'object') {
      return Promise.resolve({ ok: false, error: 'Invalid payload' });
    }
    return ipcRenderer.invoke('pad:record-tab-event', payload);
  },
  markEventProcessed(payload) {
    if (!payload || typeof payload !== 'object') {
      return Promise.resolve({ ok: false, error: 'Invalid payload' });
    }
    return ipcRenderer.invoke('pad:mark-event-processed', payload);
  },
  getEventLogState() {
    return ipcRenderer.invoke('pad:get-event-log-state');
  },
});
