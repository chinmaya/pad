const SETTINGS_STORAGE_KEY = 'pad.settings';
const RECENT_FOLDERS_STORAGE_KEY = 'pad.settings.recentFolders';

const DEFAULT_SETTINGS = Object.freeze({
  sync: {
    enabled: false,
    endpoint: '',
    folder: '',
  },
});

function readSettings() {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    return clone(DEFAULT_SETTINGS);
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch (error) {
    console.warn('Failed to parse settings, using defaults.', error);
    return clone(DEFAULT_SETTINGS);
  }
}

function writeSettings(settings) {
  const normalized = normalizeSettings(settings);
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  persistRecentFolder(normalized.sync.folder);
  return normalized;
}

function normalizeSettings(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return clone(DEFAULT_SETTINGS);
  }

  const folder = sanitizeFolderPath(candidate.sync?.folder);
  const normalized = {
    sync: {
      enabled: !!candidate.sync?.enabled,
      endpoint: typeof candidate.sync?.endpoint === 'string' ? candidate.sync.endpoint : '',
      folder,
    },
  };

  return normalized;
}

function readRecentFolders() {
  const raw = localStorage.getItem(RECENT_FOLDERS_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(item => typeof item === 'string' && item.trim())
        .map(sanitizeFolderPath)
        .filter(Boolean);
    }
  } catch (error) {
    console.warn('Failed to parse recent folders.', error);
  }

  return [];
}

function persistRecentFolder(folderPath) {
  const sanitized = sanitizeFolderPath(folderPath);
  if (!sanitized) {
    return;
  }

  const existing = readRecentFolders();
  const updated = [sanitized, ...existing.filter(item => item !== sanitized)].slice(0, 5);
  localStorage.setItem(RECENT_FOLDERS_STORAGE_KEY, JSON.stringify(updated));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeFolderPath(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  if (/[\t\r\n\f\v]/.test(trimmed)) {
    return '';
  }

  return trimmed;
}

window.padSettings = Object.freeze({
  get: () => readSettings(),
  save: newSettings => writeSettings(newSettings),
  reset: () => writeSettings(DEFAULT_SETTINGS),
  storageKey: SETTINGS_STORAGE_KEY,
  getRecentFolders: () => readRecentFolders(),
});
