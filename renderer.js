const note = document.getElementById('note');
const tabsContainer = document.getElementById('tabs');
const addTabButton = document.getElementById('add-tab');
const toggleTabsButton = document.getElementById('toggle-tabs');
const settingsButton = document.getElementById('settings-button');
const settingsModal = document.getElementById('settings-modal');
const settingsEditor = document.getElementById('settings-editor');
const settingsSaveButton = document.getElementById('settings-save');
const settingsCancelButton = document.getElementById('settings-cancel');
const settingsCloseButton = document.getElementById('settings-close');
const settingsError = document.getElementById('settings-error');
const settingsSuggestions = document.getElementById('settings-suggestions');
const resolveConflictsButton = document.getElementById('resolve-conflicts');
const mergeModal = document.getElementById('merge-modal');
const mergeCloseButton = document.getElementById('merge-close');
const mergeSubtitle = document.getElementById('merge-subtitle');
const mergeTabSelect = document.getElementById('merge-tab-select');
const mergeCurrentPane = document.getElementById('merge-current');
const mergeBackupPane = document.getElementById('merge-backup');
const mergeManualTextarea = document.getElementById('merge-manual');
const mergeKeepCurrentButton = document.getElementById('merge-keep-current');
const mergeUseBackupButton = document.getElementById('merge-use-backup');
const mergeKeepBothButton = document.getElementById('merge-keep-both');
const mergeDeleteTabButton = document.getElementById('merge-delete-tab');
const mergeUseManualButton = document.getElementById('merge-use-manual');

const STORAGE_KEY = 'pad.tabs';
const LEGACY_STORAGE_KEY = 'pad.note';
const MERGE_CONFLICTS_KEY = 'pad.mergeConflicts';
const TITLE_MAX_LENGTH = 20;
const TAB_LAYOUT_STORAGE_KEY = 'pad.tabsLayoutExpanded';

const state = loadState();
const isMac = navigator.platform.toUpperCase().includes('MAC');
let draggingTabId = null;
let tabsExpanded = loadTabsExpandedPreference();
let mergeConflicts = loadMergeConflicts();

if (window.padAPI?.onFileOpened) {
  window.padAPI.onFileOpened(handleExternalFileOpen);
}

if (window.padAPI?.onRestoreMerge) {
  window.padAPI.onRestoreMerge(handleRestoreMerge);
}

renderTabs();
applyTabsLayoutPreference();
syncNoteWithActiveTab();
initializeAutoBackup();
updateResolveConflictsButton();

function getTabIndexById(tabId) {
  return state.tabs.findIndex(tab => tab.id === tabId);
}

function toEventTab(tab) {
  if (!tab || typeof tab !== 'object') {
    return null;
  }
  return {
    id: tab.id,
    title: tab.title,
    fallbackTitle: tab.fallbackTitle,
  };
}

function queueTabEvent(payload) {
  if (!window.padAPI?.recordTabEvent) {
    return;
  }

  try {
    const promise = window.padAPI.recordTabEvent(payload);
    if (promise && typeof promise.then === 'function') {
      promise.catch(error => {
        console.warn('Failed to record tab event', error);
      });
    }
  } catch (error) {
    console.warn('Failed to record tab event', error);
  }
}

const EDIT_EVENT_INTERVAL_MS = 60_000;
const pendingTabUpdates = new Map();

function sendTabUpdateEventNow(tabId) {
  const tab = state.tabs.find(entry => entry.id === tabId) ?? null;
  if (!tab) {
    return;
  }

  queueTabEvent({
    type: 'update',
    tab: toEventTab(tab),
    tabIndex: getTabIndexById(tabId),
  });
}

function scheduleTabUpdateEvent(tabId) {
  const now = Date.now();
  const entry = pendingTabUpdates.get(tabId) ?? { lastSentAt: 0, timer: null, dirty: false };
  entry.dirty = true;

  const elapsed = entry.lastSentAt ? now - entry.lastSentAt : 0;
  if (elapsed >= EDIT_EVENT_INTERVAL_MS) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    sendTabUpdateEventNow(tabId);
    entry.lastSentAt = now;
    entry.dirty = false;
    pendingTabUpdates.set(tabId, entry);
    return;
  }

  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      const current = pendingTabUpdates.get(tabId);
      if (!current) {
        return;
      }

      current.timer = null;
      if (current.dirty) {
        sendTabUpdateEventNow(tabId);
        current.lastSentAt = Date.now();
        current.dirty = false;
      }
      pendingTabUpdates.set(tabId, current);
    }, Math.max(0, EDIT_EVENT_INTERVAL_MS - elapsed));
  }

  pendingTabUpdates.set(tabId, entry);
}

function flushTabUpdateEvent(tabId, options = {}) {
  const force = !!options.force;
  const entry = pendingTabUpdates.get(tabId);
  if (!entry) {
    return;
  }

  if (force && entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  if (force && entry.dirty) {
    sendTabUpdateEventNow(tabId);
    entry.lastSentAt = Date.now();
    entry.dirty = false;
  }

  pendingTabUpdates.set(tabId, entry);
}

window.addEventListener('beforeunload', () => {
  for (const tabId of pendingTabUpdates.keys()) {
    flushTabUpdateEvent(tabId, { force: true });
  }
});

note.addEventListener('input', event => {
  const active = getActiveTab();
  if (!active) {
    return;
  }

  active.content = event.target.value;
  const titleChanged = updateTabTitleFromContent(active);
  persistState();
  scheduleTabUpdateEvent(active.id);
  if (titleChanged) {
    renderTabs();
  }
});

document.addEventListener('keydown', event => {
  if (!isMac || !event.metaKey || event.key.toLowerCase() !== 'w') {
    return;
  }

  const active = getActiveTab();
  if (!active) {
    return;
  }

  event.preventDefault();
  closeTab(active.id);
});

addTabButton.addEventListener('click', () => {
  const newTab = createEmptyTab(getNextTabNumber());
  state.tabs.push(newTab);
  state.activeTabId = newTab.id;
  persistState();
  queueTabEvent({
    type: 'insert',
    tab: toEventTab(newTab),
    tabIndex: state.tabs.length - 1,
  });
  renderTabs();
  applyTabsLayoutPreference();
  syncNoteWithActiveTab();
  note.focus();
});

toggleTabsButton.addEventListener('click', () => {
  tabsExpanded = !tabsExpanded;
  applyTabsLayoutPreference();
  persistTabsExpandedPreference();
});

settingsButton.addEventListener('click', openSettingsModal);
settingsSaveButton.addEventListener('click', saveSettingsFromEditor);
settingsCancelButton.addEventListener('click', closeSettingsModal);
settingsCloseButton.addEventListener('click', closeSettingsModal);

settingsModal.addEventListener('click', event => {
  if (event.target === settingsModal) {
    closeSettingsModal();
  }
});

mergeModal.addEventListener('click', event => {
  if (event.target === mergeModal) {
    closeMergeModal();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !settingsModal.classList.contains('hidden')) {
    closeSettingsModal();
  }
  if (event.key === 'Escape' && !mergeModal.classList.contains('hidden')) {
    closeMergeModal();
  }
});

settingsEditor.addEventListener('input', handleSettingsEditorChange);
settingsEditor.addEventListener('click', handleSettingsEditorChange);
settingsEditor.addEventListener('keyup', handleSettingsEditorChange);

resolveConflictsButton.addEventListener('click', () => {
  const active = getActiveTab();
  const activeId = active?.id ?? null;
  if (activeId && mergeConflicts.byTabId[activeId]) {
    openMergeModal(activeId);
    return;
  }

  const first = Object.keys(mergeConflicts.byTabId)[0] ?? null;
  if (first) {
    openMergeModal(first);
  }
});

mergeCloseButton.addEventListener('click', closeMergeModal);
mergeTabSelect.addEventListener('change', () => {
  const tabId = mergeTabSelect.value;
  renderMergeConflictForTab(tabId);
});
mergeKeepCurrentButton.addEventListener('click', () => resolveMergeConflict('keep_current'));
mergeUseBackupButton.addEventListener('click', () => resolveMergeConflict('use_backup'));
mergeKeepBothButton.addEventListener('click', () => resolveMergeConflict('keep_both'));
mergeDeleteTabButton.addEventListener('click', () => resolveMergeConflict('delete_tab'));
mergeUseManualButton.addEventListener('click', () => resolveMergeConflict('use_manual'));

tabsContainer.addEventListener('dragover', event => {
  if (!draggingTabId) {
    return;
  }

  event.preventDefault();
});

tabsContainer.addEventListener('drop', event => {
  if (!draggingTabId) {
    return;
  }

  event.preventDefault();
  const targetElement = event.target.closest('.tab');
  const clientX = event.clientX;
  const moved = reorderTabsFromDrop(draggingTabId, targetElement, clientX);
  draggingTabId = null;

  if (moved) {
    persistState();
    renderTabs();
  }
});

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const parsedSaved = parseStoredTabsState(saved);
  if (parsedSaved) {
    return parsedSaved;
  }

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy !== null) {
    const firstTab = {
      id: generateId(),
      fallbackTitle: 'Tab 1',
      title: 'Tab 1',
      content: legacy,
    };
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return {
      tabs: [firstTab],
      activeTabId: firstTab.id,
      nextTabNumber: 2,
    };
  }

  const initialTab = createEmptyTab(1);
  return {
    tabs: [initialTab],
    activeTabId: initialTab.id,
    nextTabNumber: 2,
  };
}

function parseStoredTabsState(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
      return null;
    }

    const sanitizedTabs = parsed.tabs
      .filter(tab => tab && typeof tab === 'object')
      .map((tab, index) => {
        const fallbackTitle =
          typeof tab.fallbackTitle === 'string' && tab.fallbackTitle.trim()
            ? tab.fallbackTitle
            : `Tab ${index + 1}`;

        const sanitizedTab = {
          id: typeof tab.id === 'string' && tab.id ? tab.id : generateId(),
          fallbackTitle,
          title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : fallbackTitle,
          content: typeof tab.content === 'string' ? tab.content : '',
        };

        if (sanitizedTab.content.trim()) {
          updateTabTitleFromContent(sanitizedTab);
        }

        return sanitizedTab;
      });

    if (!sanitizedTabs.length) {
      return null;
    }

    const hasValidActive =
      typeof parsed.activeTabId === 'string' &&
      sanitizedTabs.some(tab => tab.id === parsed.activeTabId);

    return {
      tabs: sanitizedTabs,
      activeTabId: hasValidActive ? parsed.activeTabId : sanitizedTabs[0].id,
      nextTabNumber: sanitizeNextTabNumber(parsed.nextTabNumber, sanitizedTabs),
    };
  } catch (error) {
    console.warn('Failed to parse stored tabs.', error);
    return null;
  }
}

function loadTabsExpandedPreference() {
  return localStorage.getItem(TAB_LAYOUT_STORAGE_KEY) === 'true';
}

function persistState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      nextTabNumber: state.nextTabNumber,
    }),
  );
}

function persistTabsExpandedPreference() {
  localStorage.setItem(TAB_LAYOUT_STORAGE_KEY, tabsExpanded ? 'true' : 'false');
}

function renderTabs() {
  tabsContainer.textContent = '';

  state.tabs.forEach(tab => {
    const wrapper = document.createElement('div');
    const conflict = mergeConflicts.byTabId[tab.id];
    const isDeleteConflict =
      conflict &&
      (conflict.reason === 'deleted_in_backup' || conflict.reason === 'deleted_in_current');
    const conflictClass = conflict ? (isDeleteConflict ? ' conflict-delete' : ' conflict') : '';
    wrapper.className = `tab${tab.id === state.activeTabId ? ' active' : ''}${conflictClass}`;
    wrapper.dataset.tabId = tab.id;
    wrapper.draggable = true;
    wrapper.addEventListener('dragstart', () => {
      draggingTabId = tab.id;
      wrapper.classList.add('dragging');
    });
    wrapper.addEventListener('dragend', () => {
      wrapper.classList.remove('dragging');
      draggingTabId = null;
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab-button';
    button.textContent = tab.title;
    button.setAttribute('aria-pressed', tab.id === state.activeTabId ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (state.activeTabId === tab.id) {
        return;
      }

      state.activeTabId = tab.id;
      persistState();
      renderTabs();
      syncNoteWithActiveTab();
      note.focus();
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'tab-close';
    closeButton.textContent = 'x';
    closeButton.setAttribute('aria-label', `Close ${tab.title}`);
    closeButton.addEventListener('click', event => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    wrapper.appendChild(button);
    wrapper.appendChild(closeButton);
    tabsContainer.appendChild(wrapper);
  });
}

function loadMergeConflicts() {
  const raw = localStorage.getItem(MERGE_CONFLICTS_KEY);
  if (!raw) {
    return { byTabId: {}, meta: {} };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { byTabId: {}, meta: {} };
    }
    const byTabId = parsed.byTabId && typeof parsed.byTabId === 'object' ? parsed.byTabId : {};
    const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
    return { byTabId, meta };
  } catch {
    return { byTabId: {}, meta: {} };
  }
}

function persistMergeConflicts() {
  const hasAny = Object.keys(mergeConflicts.byTabId).length > 0;
  if (!hasAny) {
    localStorage.removeItem(MERGE_CONFLICTS_KEY);
    return;
  }

  localStorage.setItem(MERGE_CONFLICTS_KEY, JSON.stringify(mergeConflicts));
}

function updateResolveConflictsButton() {
  const count = Object.keys(mergeConflicts.byTabId).length;
  if (count === 0) {
    resolveConflictsButton.classList.add('hidden');
    resolveConflictsButton.textContent = '!';
    resolveConflictsButton.setAttribute('title', 'Resolve merge conflicts');
    resolveConflictsButton.setAttribute('aria-label', 'Resolve merge conflicts');
    return;
  }

  resolveConflictsButton.classList.remove('hidden');
  resolveConflictsButton.textContent = `!${count}`;
  resolveConflictsButton.setAttribute('title', `Resolve ${count} merge conflict${count === 1 ? '' : 's'}`);
  resolveConflictsButton.setAttribute('aria-label', `Resolve ${count} merge conflicts`);
}

function openMergeModal(tabId) {
  if (!mergeConflicts.byTabId[tabId]) {
    return;
  }

  mergeTabSelect.textContent = '';
  const conflictIds = Object.keys(mergeConflicts.byTabId);
  conflictIds.forEach(id => {
    const tab = state.tabs.find(t => t.id === id);
    const option = document.createElement('option');
    option.value = id;
    option.textContent = tab ? tab.title : id;
    mergeTabSelect.appendChild(option);
  });

  mergeTabSelect.value = tabId;
  renderMergeConflictForTab(tabId);

  mergeManualTextarea.classList.add('hidden');
  mergeModal.classList.remove('hidden');
}

function closeMergeModal() {
  mergeModal.classList.add('hidden');
  mergeManualTextarea.classList.add('hidden');
}

function renderMergeConflictForTab(tabId) {
  const conflict = mergeConflicts.byTabId[tabId];
  if (!conflict) {
    closeMergeModal();
    return;
  }

  ensureManualSuggestionDocument(conflict);

  const tab = state.tabs.find(t => t.id === tabId);
  const title = tab ? tab.title : tabId;
  const count = Object.keys(mergeConflicts.byTabId).length;
  const currentRangeText =
    conflict.currentRange && typeof conflict.currentRange.startLine === 'number'
      ? `current ${conflict.currentRange.startLine}-${conflict.currentRange.endLine}`
      : '';
  const backupRangeText =
    conflict.backupRange && typeof conflict.backupRange.startLine === 'number'
      ? `backup ${conflict.backupRange.startLine}-${conflict.backupRange.endLine}`
      : '';
  const rangeText =
    currentRangeText || backupRangeText
      ? ` • showing ${[currentRangeText, backupRangeText].filter(Boolean).join(', ')}`
      : '';

  mergeSubtitle.textContent = `${count} conflict${count === 1 ? '' : 's'} pending • ${title}${rangeText}`;

  const currentText = conflict.currentExcerpt ?? conflict.currentText ?? '';
  const backupText = conflict.backupExcerpt ?? conflict.backupText ?? '';

  const diff = window.padMerge?.diffLinesByLcs
    ? window.padMerge.diffLinesByLcs(currentText, backupText, { maxCells: 50_000 })
    : null;

  renderDiffPane(mergeCurrentPane, currentText, diff?.aChanged ?? null);
  renderDiffPane(mergeBackupPane, backupText, diff?.bChanged ?? null);
  if (!mergeManualTextarea.classList.contains('hidden')) {
    mergeManualTextarea.value = conflict.suggestedText ?? '';
  }
}

function ensureManualSuggestionDocument(conflict) {
  if (!conflict || typeof conflict !== 'object') {
    return;
  }
  if (conflict.reason !== 'conflict') {
    return;
  }

  const next = buildManualSuggestedDocument(conflict);
  if (!next) {
    return;
  }

  if (conflict.suggestedText !== next) {
    conflict.suggestedText = next;
    persistMergeConflicts();
  }
}

function buildManualSuggestedDocument(conflict) {
  const currentText = String(conflict.currentText ?? '');
  const backupText = String(conflict.backupText ?? '');

  if (!currentText && !backupText) {
    return '';
  }

  const currentLines = currentText.split(/\r?\n/);
  const backupLines = backupText.split(/\r?\n/);

  const hunkRange = conflict.currentHunkRange;
  const backupHunkRange = conflict.backupHunkRange;
  if (
    hunkRange &&
    typeof hunkRange.startLine === 'number' &&
    typeof hunkRange.endLine === 'number' &&
    backupHunkRange &&
    typeof backupHunkRange.startLine === 'number' &&
    typeof backupHunkRange.endLine === 'number'
  ) {
    const currentStart = Math.max(0, hunkRange.startLine - 1);
    const currentEnd = Math.max(currentStart, hunkRange.endLine);
    const backupStart = Math.max(0, backupHunkRange.startLine - 1);
    const backupEnd = Math.max(backupStart, backupHunkRange.endLine);

    return [
      ...currentLines.slice(0, currentStart),
      '<<<<<<< CURRENT',
      ...currentLines.slice(currentStart, currentEnd),
      '=======',
      ...backupLines.slice(backupStart, backupEnd),
      '>>>>>>> BACKUP',
      ...currentLines.slice(currentEnd),
    ].join('\n');
  }

  if (!window.padMerge?.diffLinesByLcs) {
    return ['<<<<<<< CURRENT', currentText, '=======', backupText, '>>>>>>> BACKUP'].join('\n');
  }

  const diff = window.padMerge.diffLinesByLcs(currentText, backupText, { maxCells: 200_000 });
  if (!diff) {
    return ['<<<<<<< CURRENT', currentText, '=======', backupText, '>>>>>>> BACKUP'].join('\n');
  }

  const currentRange = getFirstChangedContiguousBlockRange(diff.aChanged);
  const backupRange = getFirstChangedContiguousBlockRange(diff.bChanged);
  if (!currentRange && !backupRange) {
    return currentText;
  }

  const fallbackInsert = backupRange ? Math.min(currentLines.length, backupRange.start) : 0;
  const currentStart = currentRange ? currentRange.start : fallbackInsert;
  const currentEnd = currentRange ? currentRange.end : currentStart;
  const backupStart = backupRange ? backupRange.start : 0;
  const backupEnd = backupRange ? backupRange.end : 0;

  return [
    ...currentLines.slice(0, currentStart),
    '<<<<<<< CURRENT',
    ...currentLines.slice(currentStart, currentEnd),
    '=======',
    ...backupLines.slice(backupStart, backupEnd),
    '>>>>>>> BACKUP',
    ...currentLines.slice(currentEnd),
  ].join('\n');
}

function getFirstChangedContiguousBlockRange(changedMask) {
  if (!Array.isArray(changedMask)) {
    return null;
  }

  let start = -1;
  for (let i = 0; i < changedMask.length; i += 1) {
    if (changedMask[i]) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  let end = start;
  while (end < changedMask.length && changedMask[end]) {
    end += 1;
  }

  return { start, end };
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDiffPane(target, rawText, changedMask) {
  const lines = String(rawText ?? '').split(/\r?\n/);
  const html = lines
    .map((line, index) => {
      const changed = Array.isArray(changedMask) ? !!changedMask[index] : false;
      const safe = escapeHtml(line.length ? line : ' ');
      const className = changed ? 'diff-line changed' : 'diff-line';
      return `<div class="${className}">${safe}</div>`;
    })
    .join('');
  target.innerHTML = html;
}

function resolveMergeConflict(mode) {
  const tabId = mergeTabSelect.value;
  const conflict = mergeConflicts.byTabId[tabId];
  if (!conflict) {
    closeMergeModal();
    return;
  }

  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) {
    delete mergeConflicts.byTabId[tabId];
    persistMergeConflicts();
    updateResolveConflictsButton();
    renderTabs();
    closeMergeModal();
    return;
  }

  const currentText = String(conflict.currentText ?? '');
  const backupText = String(conflict.backupText ?? '');

  if (mode === 'delete_tab') {
    const index = state.tabs.findIndex(t => t.id === tabId);
    if (index !== -1) {
      queueTabEvent({
        type: 'delete',
        tabId,
        tabIndex: index,
      });
      state.tabs.splice(index, 1);
      if (state.tabs.length === 0) {
        const newTab = createEmptyTab(getNextTabNumber());
        state.tabs.push(newTab);
        state.activeTabId = newTab.id;
      } else if (state.activeTabId === tabId) {
        const nextIndex = index >= state.tabs.length ? state.tabs.length - 1 : index;
        state.activeTabId = state.tabs[nextIndex].id;
      }
    }
  } else if (mode === 'keep_current') {
    tab.content = currentText;
  } else if (mode === 'use_backup') {
    tab.content = backupText;
  } else if (mode === 'keep_both') {
    if (currentText && backupText) {
      tab.content = `${currentText}\n${backupText}`;
    } else {
      tab.content = currentText || backupText;
    }
  } else if (mode === 'use_manual') {
    mergeManualTextarea.classList.remove('hidden');
    if (!mergeManualTextarea.value.trim()) {
      mergeManualTextarea.value = conflict.suggestedText ?? '';
      mergeManualTextarea.focus();
      return;
    }
    tab.content = mergeManualTextarea.value;
  }

  if (mode !== 'delete_tab') {
    updateTabTitleFromContent(tab);
  }
  delete mergeConflicts.byTabId[tabId];
  persistMergeConflicts();
  updateResolveConflictsButton();
  persistState();
  if (mode !== 'delete_tab') {
    queueTabEvent({
      type: 'update',
      tab: toEventTab(tab),
      tabIndex: getTabIndexById(tab.id),
    });
  }
  renderTabs();

  if (mode !== 'delete_tab' && tab.id === state.activeTabId) {
    syncNoteWithActiveTab();
  } else if (mode === 'delete_tab') {
    syncNoteWithActiveTab();
  }

  const remaining = Object.keys(mergeConflicts.byTabId);
  if (remaining.length === 0) {
    closeMergeModal();
    return;
  }

  const nextTabId = mergeConflicts.byTabId[tabId] ? tabId : remaining[0];
  openMergeModal(nextTabId);
}

function handleRestoreMerge(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const storage = payload.storage;
  if (!storage || typeof storage !== 'object') {
    return;
  }

  const backupRawTabs = storage[STORAGE_KEY];
  const backupState = parseStoredTabsState(backupRawTabs);
  if (!backupState) {
    alert('Merge restore failed: backup did not contain valid tabs.');
    return;
  }

  mergeConflicts.byTabId = {};

  const currentById = new Map(state.tabs.map(tab => [tab.id, tab]));
  const backupById = new Map(backupState.tabs.map(tab => [tab.id, tab]));

  const currentIds = state.tabs.map(tab => tab.id);
  const backupIds = backupState.tabs.map(tab => tab.id);
  const mergedOrder = mergeTabOrderPreservingCurrent(currentIds, backupIds);

  const mergedTabs = mergedOrder
    .map(id => {
      const currentTab = currentById.get(id) ?? null;
      const backupTab = backupById.get(id) ?? null;

      if (!currentTab && backupTab) {
        return backupTab;
      }

      if (!currentTab) {
        return null;
      }

      if (!backupTab) {
        mergeConflicts.byTabId[id] = {
          currentText: currentTab.content,
          backupText: '',
          currentExcerpt: currentTab.content,
          backupExcerpt: '',
          currentRange: null,
          backupRange: null,
          currentHunkRange: null,
          backupHunkRange: null,
          suggestedText: '',
          reason: 'deleted_in_backup',
        };
        return currentTab;
      }

      const currentHash = window.padMerge?.fnv1a32
        ? window.padMerge.fnv1a32(currentTab.content)
        : currentTab.content;
      const backupHash = window.padMerge?.fnv1a32
        ? window.padMerge.fnv1a32(backupTab.content)
        : backupTab.content;

      if (currentHash === backupHash) {
        return currentTab;
      }

      const mergeResult = window.padMerge?.mergeTextByLcs
        ? window.padMerge.mergeTextByLcs(currentTab.content, backupTab.content)
        : {
            ok: false,
            reason: 'no_merge_module',
            conflict: { currentText: currentTab.content, backupText: backupTab.content },
          };

      if (mergeResult.ok) {
        currentTab.content = mergeResult.mergedText;
        updateTabTitleFromContent(currentTab);
      } else {
        mergeConflicts.byTabId[id] = {
          currentText: currentTab.content,
          backupText: backupTab.content,
          currentExcerpt: mergeResult.conflict?.currentExcerpt ?? '',
          backupExcerpt: mergeResult.conflict?.backupExcerpt ?? '',
          currentRange: mergeResult.conflict?.currentRange ?? null,
          backupRange: mergeResult.conflict?.backupRange ?? null,
          currentHunkRange: mergeResult.conflict?.currentHunkRange ?? null,
          backupHunkRange: mergeResult.conflict?.backupHunkRange ?? null,
          suggestedText: mergeResult.conflict?.suggestedText ?? '',
          reason: mergeResult.reason ?? 'conflict',
        };
      }

      return currentTab;
    })
    .filter(Boolean);

  Object.keys(storage).forEach(key => {
    if (!key || typeof key !== 'string' || !key.startsWith('pad')) {
      return;
    }
    if (key === STORAGE_KEY) {
      return;
    }
    if (localStorage.getItem(key) === null && typeof storage[key] === 'string') {
      localStorage.setItem(key, storage[key]);
    }
  });

  const mergedActive =
    typeof state.activeTabId === 'string' && mergedTabs.some(tab => tab.id === state.activeTabId)
      ? state.activeTabId
      : typeof backupState.activeTabId === 'string' && mergedTabs.some(tab => tab.id === backupState.activeTabId)
        ? backupState.activeTabId
        : mergedTabs[0]?.id ?? null;

  state.tabs = mergedTabs;
  state.activeTabId = mergedActive;
  state.nextTabNumber = sanitizeNextTabNumber(
    Math.max(state.nextTabNumber ?? 1, backupState.nextTabNumber ?? 1),
    mergedTabs,
  );

  mergeConflicts.meta = {
    createdAt: new Date().toISOString(),
    sourceBackupPath: typeof payload.sourceBackupPath === 'string' ? payload.sourceBackupPath : '',
    safetyBackupPath: typeof payload.safetyBackupPath === 'string' ? payload.safetyBackupPath : '',
  };
  persistMergeConflicts();

  persistState();
  renderTabs();
  applyTabsLayoutPreference();
  syncNoteWithActiveTab();
  updateResolveConflictsButton();

  const conflictIds = Object.keys(mergeConflicts.byTabId);
  if (conflictIds.length > 0) {
    openMergeModal(conflictIds[0]);
  } else {
    alert('Restore merged successfully.');
  }
}

function computeLcsPairsForSequence(aItems, bItems, maxCells) {
  const aLen = aItems.length;
  const bLen = bItems.length;
  const cellCount = aLen * bLen;
  if (cellCount > maxCells) {
    return null;
  }

  const dp = Array.from({ length: aLen + 1 }, () => new Uint16Array(bLen + 1));
  for (let i = 1; i <= aLen; i += 1) {
    const ai = aItems[i - 1];
    const row = dp[i];
    const prevRow = dp[i - 1];
    for (let j = 1; j <= bLen; j += 1) {
      if (ai === bItems[j - 1]) {
        row[j] = prevRow[j - 1] + 1;
      } else {
        const left = row[j - 1];
        const up = prevRow[j];
        row[j] = left > up ? left : up;
      }
    }
  }

  const pairs = [];
  let i = aLen;
  let j = bLen;
  while (i > 0 && j > 0) {
    if (aItems[i - 1] === bItems[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
      continue;
    }

    if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  pairs.reverse();
  return pairs;
}

function mergeTabOrderPreservingCurrent(currentIds, backupIds) {
  const currentSet = new Set(currentIds);
  const pairs = computeLcsPairsForSequence(currentIds, backupIds, 20_000) ?? [];

  const merged = [];
  let aIndex = 0;
  let bIndex = 0;

  for (const [ai, bi] of pairs) {
    merged.push(...currentIds.slice(aIndex, ai));

    const backupGap = backupIds.slice(bIndex, bi);
    for (const id of backupGap) {
      if (!currentSet.has(id)) {
        merged.push(id);
      }
    }

    merged.push(currentIds[ai]);
    aIndex = ai + 1;
    bIndex = bi + 1;
  }

  merged.push(...currentIds.slice(aIndex));
  for (const id of backupIds.slice(bIndex)) {
    if (!currentSet.has(id)) {
      merged.push(id);
    }
  }

  return merged;
}

function applyTabsLayoutPreference() {
  const label = tabsExpanded ? 'Show fewer tabs' : 'Show more tabs';
  tabsContainer.classList.toggle('expanded', tabsExpanded);
  toggleTabsButton.setAttribute('aria-pressed', tabsExpanded ? 'true' : 'false');
  toggleTabsButton.setAttribute('aria-label', label);
  toggleTabsButton.setAttribute('title', label);
  toggleTabsButton.textContent = tabsExpanded ? '^' : 'v';
}

function handleExternalFileOpen(payload) {
  if (!payload || typeof payload.content !== 'string') {
    return;
  }

  const active = ensureActiveTabExists();
  const hasContent = active.content.trim().length > 0;
  if (hasContent) {
    const confirmed = window.confirm(
      'Opening this file will replace the current tab content. Continue?'
    );
    if (!confirmed) {
      return;
    }
  }

  active.content = payload.content;

  const renamed = applyTitleFromFileName(active, payload.fileName);
  if (!renamed) {
    updateTabTitleFromContent(active);
  }

  persistState();
  queueTabEvent({
    type: 'update',
    tab: toEventTab(active),
    tabIndex: getTabIndexById(active.id),
  });
  renderTabs();
  syncNoteWithActiveTab();
  note.focus();
}

function syncNoteWithActiveTab() {
  const active = getActiveTab();
  note.value = active ? active.content : '';
}

function getActiveTab() {
  return state.tabs.find(tab => tab.id === state.activeTabId) ?? null;
}

function ensureActiveTabExists() {
  const current = getActiveTab();
  if (current) {
    return current;
  }

  const newTab = createEmptyTab(getNextTabNumber());
  state.tabs.push(newTab);
  state.activeTabId = newTab.id;
  return newTab;
}

function closeTab(tabId) {
  const tabIndex = state.tabs.findIndex(tab => tab.id === tabId);
  if (tabIndex === -1) {
    return;
  }

  const tab = state.tabs[tabIndex];
  const hasContent = tab.content.trim().length > 0;
  if (hasContent) {
    const confirmed = window.confirm('This tab has content. Are you sure you want to close it?');
    if (!confirmed) {
      return;
    }
  }

  flushTabUpdateEvent(tabId, { force: true });
  queueTabEvent({
    type: 'delete',
    tabId,
    tabIndex,
  });
  state.tabs.splice(tabIndex, 1);

  if (state.tabs.length === 0) {
    const newTab = createEmptyTab(getNextTabNumber());
    state.tabs.push(newTab);
    state.activeTabId = newTab.id;
  } else if (state.activeTabId === tabId) {
    const nextIndex = tabIndex >= state.tabs.length ? state.tabs.length - 1 : tabIndex;
    state.activeTabId = state.tabs[nextIndex].id;
  }

  persistState();
  renderTabs();
  syncNoteWithActiveTab();
  note.focus();
}

function createEmptyTab(position) {
  const fallbackTitle = `Tab ${position}`;
  return {
    id: generateId(),
    title: fallbackTitle,
    fallbackTitle,
    content: '',
  };
}

function getNextTabNumber() {
  if (!Number.isFinite(state.nextTabNumber) || state.nextTabNumber < 1) {
    state.nextTabNumber = sanitizeNextTabNumber(undefined, state.tabs);
  }

  const next = state.nextTabNumber;
  state.nextTabNumber += 1;
  return next;
}

function sanitizeNextTabNumber(candidate, tabs) {
  if (Number.isFinite(candidate) && candidate > 0) {
    return Math.max(candidate, getHighestTabNumber(tabs) + 1);
  }

  return getHighestTabNumber(tabs) + 1;
}

function getHighestTabNumber(tabs) {
  return tabs.reduce((highest, tab) => {
    const sourceTitle =
      (typeof tab.fallbackTitle === 'string' && tab.fallbackTitle.trim()) ||
      (typeof tab.title === 'string' && tab.title.trim()) ||
      '';
    const match = /^Tab (\d+)$/.exec(sourceTitle);
    if (!match) {
      return highest;
    }

    const numericValue = Number(match[1]);
    if (!Number.isFinite(numericValue)) {
      return highest;
    }

    return Math.max(highest, numericValue);
  }, 0);
}

function generateId() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateTabTitleFromContent(tab) {
  const derivedTitle = deriveTitleFromContent(tab.content);
  const fallbackTitle = tab.fallbackTitle || tab.title;
  const nextTitle = derivedTitle || fallbackTitle;

  if (tab.title === nextTitle) {
    return false;
  }

  tab.title = nextTitle;
  return true;
}

function deriveTitleFromContent(content) {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const normalized = firstLine.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }

  const words = normalized.split(' ');
  let result = '';

  for (const word of words) {
    const candidate = result ? `${result} ${word}` : word;
    if (candidate.length > TITLE_MAX_LENGTH) {
      if (!result) {
        return word.slice(0, TITLE_MAX_LENGTH);
      }
      break;
    }

    result = candidate;
    if (result.length === TITLE_MAX_LENGTH) {
      break;
    }
  }

  return result;
}

function applyTitleFromFileName(tab, rawFileName) {
  if (!rawFileName || typeof rawFileName !== 'string') {
    return false;
  }

  const cleaned = rawFileName.trim();
  if (!cleaned) {
    return false;
  }

  const truncated = cleaned.length > TITLE_MAX_LENGTH ? cleaned.slice(0, TITLE_MAX_LENGTH) : cleaned;
  tab.title = truncated;
  tab.fallbackTitle = truncated;
  return true;
}

function reorderTabsFromDrop(tabId, targetElement, clientX) {
  const targetId = targetElement?.dataset.tabId ?? null;
  let targetIndex = state.tabs.length;

  if (targetId) {
    const baseIndex = state.tabs.findIndex(tab => tab.id === targetId);
    if (baseIndex === -1) {
      return false;
    }

    const rect = targetElement.getBoundingClientRect();
    const dropBefore = clientX < rect.left + rect.width / 2;
    targetIndex = dropBefore ? baseIndex : baseIndex + 1;
  }

  return moveTabToIndex(tabId, targetIndex);
}

function moveTabToIndex(tabId, rawTargetIndex) {
  const fromIndex = state.tabs.findIndex(tab => tab.id === tabId);
  if (fromIndex === -1) {
    return false;
  }

  let targetIndex = Math.max(0, Math.min(rawTargetIndex, state.tabs.length));

  if (targetIndex === fromIndex || targetIndex === fromIndex + 1) {
    return false;
  }

  const [tab] = state.tabs.splice(fromIndex, 1);
  if (targetIndex > fromIndex) {
    targetIndex -= 1;
  }

  state.tabs.splice(targetIndex, 0, tab);
  return true;
}

window.padBackup = syncService;

async function openSettingsModal() {
  try {
    const settings = await padAppSettings.get();
    settingsEditor.value = JSON.stringify(settings, null, 2);
    await renderFolderSuggestions(settings);
    settingsError.textContent = '';
    settingsModal.classList.remove('hidden');
    settingsEditor.focus();
    settingsEditor.setSelectionRange(settingsEditor.value.length, settingsEditor.value.length);
  } catch (error) {
    console.error('Failed to open settings', error);
    settingsError.textContent = 'Failed to load settings.';
  }
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

async function saveSettingsFromEditor() {
  try {
    const parsed = JSON.parse(settingsEditor.value);
    const saved = await padAppSettings.save(parsed);

    settingsEditor.value = JSON.stringify(saved, null, 2);
    await renderFolderSuggestions(saved);

    const hadFolder = parsed?.backup && typeof parsed.backup.folder === 'string' && parsed.backup.folder.trim();
    if (hadFolder && !saved.backup.folder) {
      settingsError.textContent = 'Settings saved, but backup.folder was cleared: remove control characters or escape backslashes (e.g. C:\\\\path or C:/path).';
    } else {
      settingsError.textContent = 'Settings saved.';
    }

    if (window.padAPI?.updateAutoBackup) {
      window.padAPI.updateAutoBackup();
    }

    setTimeout(closeSettingsModal, 300);
  } catch (error) {
    console.warn('Failed to save settings', error);
    settingsError.textContent = 'Invalid JSON. Please fix and try again.';
  }
}

function handleSettingsEditorChange() {
  try {
    const current = JSON.parse(settingsEditor.value);
    renderFolderSuggestions(current);
  } catch {
    hideFolderSuggestions();
  }
}

async function renderFolderSuggestions(settingsSnapshot) {
  const candidate = settingsSnapshot?.backup?.folder;
  const partial = typeof candidate === 'string' ? candidate : '';
  const recent = await padAppSettings.getRecentFolders();
  const matching = recent.filter(item =>
    partial ? item.toLowerCase().startsWith(partial.toLowerCase()) : true,
  );

  settingsSuggestions.textContent = '';

  if (!matching.length) {
    settingsSuggestions.classList.add('hidden');
    return;
  }

  matching.forEach(path => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = path;
    button.addEventListener('click', () => applyFolderSuggestion(path));
    settingsSuggestions.appendChild(button);
  });

  settingsSuggestions.classList.remove('hidden');
}

function applyFolderSuggestion(folderPath) {
  try {
    const parsed = JSON.parse(settingsEditor.value);
    if (!parsed.backup || typeof parsed.backup !== 'object') {
      parsed.backup = {};
    }
    parsed.backup.folder = folderPath;
    settingsEditor.value = JSON.stringify(parsed, null, 2);
    renderFolderSuggestions(parsed);
  } catch (error) {
    console.warn('Failed to apply folder suggestion', error);
  }
}

function hideFolderSuggestions() {
  settingsSuggestions.textContent = '';
  settingsSuggestions.classList.add('hidden');
}

function initializeAutoBackup() {
  if (window.padAPI?.updateAutoBackup) {
    window.padAPI.updateAutoBackup();
  }
}
