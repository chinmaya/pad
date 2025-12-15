const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const BACKUP_PREFIX = 'padbackup-';
const BACKUP_EXTENSION = '.json';
const DEFAULT_MAX_BACKUPS = 10;

function createBackupManager({ app }) {
  let autoBackupInterval = null;

  async function create(window, options = {}) {
    if (!window || window.isDestroyed()) {
      return { ok: false, error: 'No active window' };
    }

    try {
      const snapshot = await exportPadStorage(window);
      const backupDirectory = options.directory || (await ensureBackupDirectory());
      const timestamp = buildTimestamp();
      const fileName = `${BACKUP_PREFIX}${timestamp}${BACKUP_EXTENSION}`;
      const targetPath = path.join(backupDirectory, fileName);
      await fs.writeFile(
        targetPath,
        JSON.stringify({ createdAt: new Date().toISOString(), storage: snapshot }, null, 2),
        'utf8',
      );

      const maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;
      await cleanupOldBackups(backupDirectory, maxBackups);

      return { ok: true, path: targetPath };
    } catch (error) {
      console.error('Failed to create backup', error);
      return { ok: false, error: error.message };
    }
  }

  async function createAutoBackup(window, customDirectory = null) {
    if (!window || window.isDestroyed()) {
      return { ok: false, error: 'No active window' };
    }

    try {
      const snapshot = await exportPadStorage(window);
      const backupDirectory = customDirectory || (await ensureBackupDirectory());
      await fs.mkdir(backupDirectory, { recursive: true });
      const machineName = os.hostname().replace(/[^a-zA-Z0-9-_]/g, '');
      const fileName = `${BACKUP_PREFIX}auto-${machineName}${BACKUP_EXTENSION}`;
      const targetPath = path.join(backupDirectory, fileName);

      let isFirstCreate = false;
      try {
        await fs.access(targetPath);
      } catch {
        isFirstCreate = true;
      }

      await fs.writeFile(
        targetPath,
        JSON.stringify({ createdAt: new Date().toISOString(), storage: snapshot, auto: true }, null, 2),
        'utf8',
      );
      return { ok: true, path: targetPath, isFirstCreate };
    } catch (error) {
      console.error('Failed to create auto backup', error);
      return { ok: false, error: error.message };
    }
  }

  async function restore(window, backupPath) {
    if (!window || window.isDestroyed()) {
      return { ok: false, error: 'No active window' };
    }

    try {
      const raw = await fs.readFile(backupPath, 'utf8');
      const parsed = JSON.parse(raw);
      const storage = parsed?.storage;
      if (!storage || typeof storage !== 'object') {
        return { ok: false, error: 'Backup file is missing storage content.' };
      }

      await applyBackupToWindow(window, storage);
      return { ok: true };
    } catch (error) {
      console.error('Failed to restore backup', error);
      return { ok: false, error: error.message };
    }
  }

  async function list(customDirectory = null) {
    try {
      const directory = customDirectory || (await ensureBackupDirectory());
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const backups = entries
        .filter(
          entry =>
            entry.isFile() &&
            entry.name.startsWith(BACKUP_PREFIX) &&
            entry.name.endsWith(BACKUP_EXTENSION),
        )
        .map(entry => {
          const displayName = entry.name.replace(BACKUP_EXTENSION, '');
          return { displayName, path: path.join(directory, entry.name) };
        });

      backups.sort((a, b) => (a.displayName < b.displayName ? 1 : -1));
      return backups;
    } catch (error) {
      console.warn('Failed to read backups', error);
      return [];
    }
  }

  async function getLatestBackup(customDirectory = null) {
    const backups = await list(customDirectory);
    return backups.length > 0 ? backups[0] : null;
  }

  async function isCurrentStateBackedUp(window, customDirectory = null) {
    if (!window || window.isDestroyed()) {
      return { backed: false, error: 'No active window' };
    }

    try {
      const latestBackup = await getLatestBackup(customDirectory);
      if (!latestBackup) {
        return { backed: false, reason: 'no_backups' };
      }

      const currentSnapshot = await exportPadStorage(window);
      const raw = await fs.readFile(latestBackup.path, 'utf8');
      const parsed = JSON.parse(raw);
      const backupSnapshot = parsed?.storage;

      if (!backupSnapshot) {
        return { backed: false, reason: 'invalid_backup' };
      }

      const currentKeys = Object.keys(currentSnapshot).sort();
      const backupKeys = Object.keys(backupSnapshot).sort();

      if (currentKeys.length !== backupKeys.length) {
        return { backed: false, reason: 'different_keys' };
      }

      for (const key of currentKeys) {
        if (currentSnapshot[key] !== backupSnapshot[key]) {
          return { backed: false, reason: 'different_values' };
        }
      }

      return { backed: true };
    } catch (error) {
      console.error('Failed to check backup status', error);
      return { backed: false, error: error.message };
    }
  }

  async function cleanupOldBackups(directory, maxBackups) {
    if (maxBackups <= 0) {
      return;
    }

    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const backups = entries
        .filter(
          entry =>
            entry.isFile() &&
            entry.name.startsWith(BACKUP_PREFIX) &&
            entry.name.endsWith(BACKUP_EXTENSION) &&
            !entry.name.startsWith(`${BACKUP_PREFIX}auto-`),
        )
        .map(entry => ({
          name: entry.name,
          path: path.join(directory, entry.name),
        }));

      backups.sort((a, b) => (a.name < b.name ? 1 : -1));

      if (backups.length > maxBackups) {
        const toDelete = backups.slice(maxBackups);
        for (const backup of toDelete) {
          await fs.unlink(backup.path);
        }
      }
    } catch (error) {
      console.warn('Failed to cleanup old backups', error);
    }
  }

  function startAutoBackup(window, intervalMinutes, customDirectory = null, onFirstCreate = null) {
    stopAutoBackup();
    if (!intervalMinutes || intervalMinutes <= 0) {
      return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    autoBackupInterval = setInterval(async () => {
      if (window && !window.isDestroyed()) {
        const result = await createAutoBackup(window, customDirectory);
        if (result.ok && result.isFirstCreate && typeof onFirstCreate === 'function') {
          onFirstCreate();
        }
      }
    }, intervalMs);
  }

  function stopAutoBackup() {
    if (autoBackupInterval) {
      clearInterval(autoBackupInterval);
      autoBackupInterval = null;
    }
  }

  async function ensureBackupDirectory() {
    const directory = path.join(app.getPath('userData'), 'backups');
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }

  function getDefaultBackupDirectory() {
    return path.join(app.getPath('userData'), 'backups');
  }

  return Object.freeze({
    create,
    createAutoBackup,
    restore,
    list,
    getLatestBackup,
    isCurrentStateBackedUp,
    startAutoBackup,
    stopAutoBackup,
    getDefaultBackupDirectory,
  });
}

async function exportPadStorage(window) {
  return window.webContents.executeJavaScript(`(() => {
    const snapshot = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('pad')) {
        snapshot[key] = localStorage.getItem(key);
      }
    }
    return snapshot;
  })();`);
}

async function applyBackupToWindow(window, storage) {
  const serialized = JSON.stringify(storage);
  await window.webContents.executeJavaScript(`(() => {
    const restored = ${serialized};
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('pad')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    for (const [key, value] of Object.entries(restored)) {
      if (typeof value === 'string') {
        localStorage.setItem(key, value);
      }
    }
  })();`);
}

function buildTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .replace('Z', '');
}

module.exports = {
  createBackupManager,
};
