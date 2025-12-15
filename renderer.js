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

const STORAGE_KEY = 'pad.tabs';
const LEGACY_STORAGE_KEY = 'pad.note';
const TITLE_MAX_LENGTH = 20;
const TAB_LAYOUT_STORAGE_KEY = 'pad.tabsLayoutExpanded';

const state = loadState();
const isMac = navigator.platform.toUpperCase().includes('MAC');
let draggingTabId = null;
let tabsExpanded = loadTabsExpandedPreference();

if (window.padAPI?.onFileOpened) {
  window.padAPI.onFileOpened(handleExternalFileOpen);
}

renderTabs();
applyTabsLayoutPreference();
syncNoteWithActiveTab();
initializeAutoBackup();

note.addEventListener('input', event => {
  const active = getActiveTab();
  if (!active) {
    return;
  }

  active.content = event.target.value;
  const titleChanged = updateTabTitleFromContent(active);
  persistState();
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

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !settingsModal.classList.contains('hidden')) {
    closeSettingsModal();
  }
});

settingsEditor.addEventListener('input', handleSettingsEditorChange);
settingsEditor.addEventListener('click', handleSettingsEditorChange);
settingsEditor.addEventListener('keyup', handleSettingsEditorChange);

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
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length) {
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
              title:
                typeof tab.title === 'string' && tab.title.trim() ? tab.title : fallbackTitle,
              content: typeof tab.content === 'string' ? tab.content : '',
            };

            if (sanitizedTab.content.trim()) {
              updateTabTitleFromContent(sanitizedTab);
            }

            return sanitizedTab;
          });

        if (sanitizedTabs.length) {
          const hasValidActive =
            typeof parsed.activeTabId === 'string' &&
            sanitizedTabs.some(tab => tab.id === parsed.activeTabId);
          return {
            tabs: sanitizedTabs,
            activeTabId: hasValidActive ? parsed.activeTabId : sanitizedTabs[0].id,
            nextTabNumber: sanitizeNextTabNumber(parsed.nextTabNumber, sanitizedTabs),
          };
        }
      }
    } catch (error) {
      console.warn('Failed to parse stored tabs, starting fresh.', error);
    }
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
    wrapper.className = `tab${tab.id === state.activeTabId ? ' active' : ''}`;
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
