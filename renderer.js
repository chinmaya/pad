const note = document.getElementById('note');
const tabsContainer = document.getElementById('tabs');
const addTabButton = document.getElementById('add-tab');

const STORAGE_KEY = 'pad.tabs';
const LEGACY_STORAGE_KEY = 'pad.note';

const state = loadState();
const isMac = navigator.platform.toUpperCase().includes('MAC');

renderTabs();
syncNoteWithActiveTab();

note.addEventListener('input', event => {
  const active = getActiveTab();
  if (!active) {
    return;
  }

  active.content = event.target.value;
  persistState();
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
  syncNoteWithActiveTab();
  note.focus();
});

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length) {
        const sanitizedTabs = parsed.tabs
          .filter(tab => tab && typeof tab === 'object')
          .map((tab, index) => ({
            id: typeof tab.id === 'string' && tab.id ? tab.id : generateId(),
            title:
              typeof tab.title === 'string' && tab.title.trim()
                ? tab.title
                : `Tab ${index + 1}`,
            content: typeof tab.content === 'string' ? tab.content : '',
          }));

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

function renderTabs() {
  tabsContainer.textContent = '';

  state.tabs.forEach(tab => {
    const wrapper = document.createElement('div');
    wrapper.className = `tab${tab.id === state.activeTabId ? ' active' : ''}`;

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

function syncNoteWithActiveTab() {
  const active = getActiveTab();
  note.value = active ? active.content : '';
}

function getActiveTab() {
  return state.tabs.find(tab => tab.id === state.activeTabId) ?? null;
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
  return {
    id: generateId(),
    title: `Tab ${position}`,
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
    const match = /^Tab (\d+)$/.exec(tab.title.trim());
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
