function createSyncService({ getStateSnapshot, persistState, persistTabsLayout }) {
  function buildPayload() {
    const snapshot = getStateSnapshot();
    return {
      tabs: snapshot.tabs,
      activeTabId: snapshot.activeTabId,
      nextTabNumber: snapshot.nextTabNumber,
      tabsExpanded: snapshot.tabsExpanded,
    };
  }

  async function copySnapshot() {
    persistState();
    persistTabsLayout();
    const payload = JSON.stringify(buildPayload());

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        return { copied: true, payload };
      }
    } catch (error) {
      console.warn('Failed to write backup to clipboard, returning payload instead.', error);
    }

    return { copied: false, payload };
  }

  return Object.freeze({
    getSnapshot: () => buildPayload(),
    copySnapshot,
    startWorker,
  });
}

window.padSync = Object.freeze({
  create: createSyncService,
  startWorker,
});

function startWorker({ intervalMs = 10_000, getSettings, getSnapshot }) {
  let timer = null;

  async function tick() {
    const settings = await getSettings();
    const folderPath = settings?.folder;
    if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
      return;
    }

    const payload = {
      folderPath,
      content: JSON.stringify(getSnapshot()),
    };

    try {
      const result = await window.padAPI?.saveSnapshot(payload);
      if (!result?.ok) {
        console.warn('Snapshot save failed', result?.error);
      }
    } catch (error) {
      console.warn('Snapshot save error', error);
    }
  }

  timer = setInterval(tick, intervalMs);
  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
