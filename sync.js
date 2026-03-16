function createSyncService({ getStateSnapshot, persistState, persistTabsLayout, getMachineName }) {
  function buildPayload() {
    const snapshot = getStateSnapshot();
    const machineName = getMachineName ? getMachineName() : 'unknown';

    // Use prepareSnapshotForSync if available for proper sync metadata
    if (window.padSyncMerge?.prepareSnapshotForSync) {
      return window.padSyncMerge.prepareSnapshotForSync(snapshot, machineName);
    }

    // Fallback to basic payload
    return {
      tabs: snapshot.tabs,
      activeTabId: snapshot.activeTabId,
      nextTabNumber: snapshot.nextTabNumber,
      tabsExpanded: snapshot.tabsExpanded,
      groups: snapshot.groups,
      activeGroupId: snapshot.activeGroupId,
      nextGroupNumber: snapshot.nextGroupNumber,
      machineName,
      savedAt: new Date().toISOString(),
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

function startWorker({ intervalMs = 10_000, getSettings, getSnapshot, getMachineName, onMergeComplete, onSyncComplete }) {
  let timer = null;
  let mergeTimer = null;
  const MERGE_INTERVAL_MS = 30_000; // Check for merges every 30 seconds

  async function tick() {
    const settings = await getSettings();
    const folderPath = settings?.folder;
    if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
      return;
    }

    const machineName = getMachineName ? getMachineName() : 'unknown';
    const snapshot = getSnapshot();

    // Use prepareSnapshotForSync if available
    const preparedSnapshot = window.padSyncMerge?.prepareSnapshotForSync
      ? window.padSyncMerge.prepareSnapshotForSync(snapshot, machineName)
      : snapshot;

    const payload = {
      folderPath,
      content: JSON.stringify(preparedSnapshot),
    };

    try {
      const result = await window.padAPI?.saveSnapshot(payload);
      if (result?.ok) {
        // Notify that sync was successful so local state can update lastSyncedHash
        if (onSyncComplete) {
          onSyncComplete(preparedSnapshot);
        }
      } else {
        console.warn('Snapshot save failed', result?.error);
      }
    } catch (error) {
      console.warn('Snapshot save error', error);
    }
  }

  async function mergeTick() {
    if (!window.padAPI?.readAllSnapshots || !window.padSyncMerge?.mergeAllMachines) {
      console.log('[sync] mergeTick: APIs not available');
      return;
    }

    try {
      const result = await window.padAPI.readAllSnapshots();
      console.log('[sync] readAllSnapshots result:', result.ok, 'snapshots:', result.snapshots?.length);
      if (!result.ok || !result.snapshots || result.snapshots.length < 2) {
        // Need at least 2 machines to merge
        return;
      }

      const machineName = getMachineName ? getMachineName() : 'unknown';
      const mergeResult = window.padSyncMerge.mergeAllMachines(result.snapshots);
      console.log('[sync] merge result:', mergeResult.mergedTabs?.length, 'tabs,', mergeResult.conflicts?.length, 'conflicts');

      if (onMergeComplete) {
        onMergeComplete(mergeResult, machineName);
      }
    } catch (error) {
      console.warn('Merge check failed', error);
    }
  }

  timer = setInterval(tick, intervalMs);
  mergeTimer = setInterval(mergeTick, MERGE_INTERVAL_MS);

  // Run initial ticks
  tick();
  // Delay initial merge to allow save to complete first
  setTimeout(mergeTick, 2000);

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (mergeTimer) {
        clearInterval(mergeTimer);
        mergeTimer = null;
      }
    },
    tick,
    mergeTick,
  };
}
