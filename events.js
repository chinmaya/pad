const fs = require('fs/promises');
const path = require('path');
const { getConfiguredMachineName } = require('./machine-name');

const EVENTS_PREFIX = 'events-auto-';
const EVENTS_EXTENSION = '.json';
const SCHEMA_VERSION = 1;

function generateEventId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function areTabMetasEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  return a.id === b.id && a.title === b.title && a.fallbackTitle === b.fallbackTitle;
}

function isSameEvent(lastEvent, nextEvent) {
  if (!lastEvent || typeof lastEvent !== 'object' || !nextEvent || typeof nextEvent !== 'object') {
    return false;
  }
  if (lastEvent.type !== nextEvent.type) {
    return false;
  }
  if (lastEvent.tabId !== nextEvent.tabId) {
    return false;
  }
  if (lastEvent.tabIndex !== nextEvent.tabIndex) {
    return false;
  }
  return areTabMetasEqual(lastEvent.tab, nextEvent.tab);
}

function buildDefaultState(machineName) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    machineName,
    createdAt: now,
    updatedAt: now,
    events: [],
    processed: [],
  };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeState(candidate, machineName) {
  const base = buildDefaultState(machineName);
  if (!candidate || typeof candidate !== 'object') {
    return base;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    machineName,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : base.createdAt,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : base.updatedAt,
    events: ensureArray(candidate.events),
    processed: ensureArray(candidate.processed),
  };
}

function createEventLogManager({ app }) {
  const machineName = getConfiguredMachineName();
  let writeQueue = Promise.resolve();

  function getDefaultBackupDirectory() {
    return path.join(app.getPath('userData'), 'backups');
  }

  function getEventsFilePath(customDirectory = null) {
    const directory = customDirectory || getDefaultBackupDirectory();
    const fileName = `${EVENTS_PREFIX}${machineName}${EVENTS_EXTENSION}`;
    return path.join(directory, fileName);
  }

  async function readState(customDirectory = null) {
    const filePath = getEventsFilePath(customDirectory);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeState(parsed, machineName);
    } catch {
      return buildDefaultState(machineName);
    }
  }

  async function writeState(nextState, customDirectory = null) {
    const filePath = getEventsFilePath(customDirectory);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(nextState, null, 2), 'utf8');
    return filePath;
  }

  function enqueueWrite(task) {
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  function recordEvent(payload, customDirectory = null) {
    return enqueueWrite(async () => {
      const type = payload?.type;
      if (type !== 'insert' && type !== 'delete' && type !== 'update') {
        return { ok: false, error: 'Invalid event type' };
      }

      const tab = payload?.tab && typeof payload.tab === 'object' ? payload.tab : null;
      const tabId = typeof payload?.tabId === 'string' ? payload.tabId : tab?.id ?? null;
      if (!tabId || typeof tabId !== 'string') {
        return { ok: false, error: 'Missing tabId' };
      }

      if (type !== 'delete' && (!tab || typeof tab.id !== 'string')) {
        return { ok: false, error: 'Missing tab for insert/update' };
      }

      const tabMeta =
        type === 'delete'
          ? null
          : {
              id: tab.id,
              title: tab.title,
              fallbackTitle: tab.fallbackTitle,
            };

      const rawTabIndex = payload?.tabIndex;
      const tabIndex =
        Number.isFinite(rawTabIndex) && rawTabIndex >= 0 ? Math.floor(rawTabIndex) : null;

      const nextState = await readState(customDirectory);
      const now = new Date().toISOString();
      const event = {
        id: generateEventId(),
        type,
        tabId,
        tabIndex,
        timestamp: now,
        tab: tabMeta,
      };

      const lastEvent = nextState.events.length ? nextState.events[nextState.events.length - 1] : null;
      if (isSameEvent(lastEvent, event)) {
        lastEvent.timestamp = now;
        nextState.updatedAt = now;
      } else {
        nextState.updatedAt = now;
        nextState.events.push(event);
      }
      const filePath = await writeState(nextState, customDirectory);
      return { ok: true, filePath, event };
    });
  }

  function markProcessed(payload, customDirectory = null) {
    return enqueueWrite(async () => {
      const eventId = typeof payload?.eventId === 'string' ? payload.eventId : '';
      const sourceMachineName = typeof payload?.machineName === 'string' ? payload.machineName : '';
      if (!eventId || !sourceMachineName) {
        return { ok: false, error: 'Missing eventId or machineName' };
      }

      const nextState = await readState(customDirectory);
      const exists = nextState.processed.some(
        entry => entry && entry.eventId === eventId && entry.machineName === sourceMachineName,
      );
      if (!exists) {
        nextState.processed.push({
          eventId,
          machineName: sourceMachineName,
          processedAt: new Date().toISOString(),
        });
        nextState.updatedAt = new Date().toISOString();
        const filePath = await writeState(nextState, customDirectory);
        return { ok: true, filePath };
      }

      return { ok: true, alreadyProcessed: true };
    });
  }

  async function getState(customDirectory = null) {
    const state = await readState(customDirectory);
    return { ok: true, state, filePath: getEventsFilePath(customDirectory) };
  }

  return Object.freeze({
    getEventsFilePath,
    recordEvent,
    markProcessed,
    getState,
  });
}

module.exports = {
  createEventLogManager,
};
