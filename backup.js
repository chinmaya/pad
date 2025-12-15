const fs = require('fs/promises');
const path = require('path');

const BACKUP_PREFIX = 'padbackup-';
const BACKUP_EXTENSION = '.json';

function createBackupManager({ app }) {
  async function create(window) {
    if (!window || window.isDestroyed()) {
      return { ok: false, error: 'No active window' };
    }

    try {
      const snapshot = await exportPadStorage(window);
      const backupDirectory = await ensureBackupDirectory();
      const timestamp = buildTimestamp();
      const fileName = `${BACKUP_PREFIX}${timestamp}${BACKUP_EXTENSION}`;
      const targetPath = path.join(backupDirectory, fileName);
      await fs.writeFile(
        targetPath,
        JSON.stringify({ createdAt: new Date().toISOString(), storage: snapshot }, null, 2),
        'utf8',
      );
      return { ok: true, path: targetPath };
    } catch (error) {
      console.error('Failed to create backup', error);
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

  async function list() {
    try {
      const directory = await ensureBackupDirectory();
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

  async function ensureBackupDirectory() {
    const directory = path.join(app.getPath('userData'), 'backups');
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }

  return Object.freeze({
    create,
    restore,
    list,
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
