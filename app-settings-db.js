const DB_NAME = 'padAppSettings';
const DB_VERSION = 1;
const STORE_NAME = 'settings';

const DEFAULT_BACKUP_SETTINGS = {
  folder: '',
  maxBackups: 10,
  autoBackupEnabled: false,
  autoBackupIntervalMinutes: 30,
};

let dbInstance = null;
let recentFoldersCache = null;

function openDatabase() {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = event => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
  });
}

async function getSetting(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);

    request.onerror = () => reject(new Error('Failed to read setting'));
    request.onsuccess = () => resolve(request.result?.value ?? null);
  });
}

async function setSetting(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put({ key, value });

    request.onerror = () => reject(new Error('Failed to write setting'));
    request.onsuccess = () => resolve(value);
  });
}

// Backup settings
async function getBackupSettings() {
  try {
    const stored = await getSetting('backup');
    if (!stored || typeof stored !== 'object') {
      return { ...DEFAULT_BACKUP_SETTINGS };
    }
    return normalizeBackupSettings(stored);
  } catch (error) {
    console.warn('Failed to read backup settings from IndexedDB', error);
    return { ...DEFAULT_BACKUP_SETTINGS };
  }
}

async function setBackupSettings(settings) {
  const normalized = normalizeBackupSettings(settings);
  await setSetting('backup', normalized);
  return normalized;
}

async function updateBackupSettings(updater) {
  const current = await getBackupSettings();
  const updated = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
  return setBackupSettings(updated);
}

function normalizeBackupSettings(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { ...DEFAULT_BACKUP_SETTINGS };
  }

  return {
    folder: sanitizeFolderPath(candidate.folder),
    maxBackups: normalizePositiveInt(candidate.maxBackups, DEFAULT_BACKUP_SETTINGS.maxBackups),
    autoBackupEnabled: !!candidate.autoBackupEnabled,
    autoBackupIntervalMinutes: normalizePositiveInt(
      candidate.autoBackupIntervalMinutes,
      DEFAULT_BACKUP_SETTINGS.autoBackupIntervalMinutes,
    ),
  };
}

// Combined settings
async function getAllSettings() {
  const backup = await getBackupSettings();
  return { backup };
}

async function setAllSettings(settings) {
  const backup = await setBackupSettings(settings?.backup || {});
  return { backup };
}

// Recent folders
async function getRecentFolders() {
  try {
    const stored = await getSetting('recentFolders');
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter(item => typeof item === 'string' && item.trim()).map(sanitizeFolderPath).filter(Boolean);
  } catch {
    return [];
  }
}

async function persistRecentFolder(folderPath) {
  const sanitized = sanitizeFolderPath(folderPath);
  if (!sanitized) {
    return;
  }

  const existing = await getRecentFolders();
  const updated = [sanitized, ...existing.filter(item => item !== sanitized)].slice(0, 5);
  await setSetting('recentFolders', updated);
}

// Helpers
function normalizePositiveInt(value, defaultValue) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return defaultValue;
}

function sanitizeFolderPath(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  const trimmed = raw.trim();
  if (!trimmed || /[\t\r\n\f\v]/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

window.padAppSettings = Object.freeze({
  get: getAllSettings,
  save: setAllSettings,
  getBackupSettings,
  setBackupSettings,
  updateBackupSettings,
  getRecentFolders,
});
