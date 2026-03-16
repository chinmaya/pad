/**
 * Multi-machine sync merge with tombstone-based delete detection.
 *
 * Each machine writes to its own save_{machineName}.json file.
 * This module merges all machine snapshots into a unified state.
 */

const TOMBSTONE_TTL_DAYS = 30;

/**
 * Merge tabs from multiple machine snapshots.
 * Uses content-hash-based conflict detection to catch divergent edits regardless of timing.
 *
 * @param {Array<{machineName: string, snapshot: object}>} machineSnapshots
 * @returns {{
 *   mergedTabs: Array,
 *   conflicts: Array<{tabId: string, machines: Array<{machineName: string, tab: object}>}>,
 *   tombstones: Array<{id: string, deleted: boolean, deletedAt: string, deletedBy: string}>
 * }}
 */
function mergeAllMachines(machineSnapshots) {
  // Collect all tabs and tombstones by ID
  const tabVersions = new Map(); // tabId -> [{machineName, tab, timestamp}]

  for (const { machineName, snapshot } of machineSnapshots) {
    if (!snapshot || !Array.isArray(snapshot.tabs)) {
      continue;
    }

    for (const tab of snapshot.tabs) {
      if (!tab || !tab.id) {
        continue;
      }

      const timestamp = tab.deleted
        ? new Date(tab.deletedAt || 0).getTime()
        : new Date(tab.updatedAt || 0).getTime();

      if (!tabVersions.has(tab.id)) {
        tabVersions.set(tab.id, []);
      }

      tabVersions.get(tab.id).push({
        machineName,
        tab,
        timestamp,
      });
    }
  }

  const mergedTabs = [];
  const conflicts = [];
  const tombstones = [];

  for (const [, versions] of tabVersions) {
    // Sort by timestamp descending (newest first)
    versions.sort((a, b) => b.timestamp - a.timestamp);

    const newest = versions[0];

    // The newest version wins - if it's a tombstone, the tab is deleted
    // If it's a live tab, the tab exists (even if there's an older tombstone)
    if (newest.tab.deleted) {
      tombstones.push(newest.tab);
      continue;
    }

    // Conflict detection is now handled in handleMergeResult based on local state
    // mergeAllMachines just returns the newest version - the renderer decides what to do

    // Take the newest live version
    mergedTabs.push(newest.tab);
  }

  return {
    mergedTabs,
    conflicts,
    tombstones,
  };
}

/**
 * Check if a tab has changed since it was last synced.
 * Returns true if content differs from lastSyncedHash, or if we can't determine.
 *
 * @param {object} tab
 * @returns {boolean}
 */
function hasChangedSinceLastSync(tab) {
  if (!tab || tab.deleted) {
    return false;
  }

  // If no lastSyncedHash, assume it has changed (be cautious)
  if (tab.lastSyncedHash === undefined || tab.lastSyncedHash === null) {
    return true;
  }

  const currentHash = hashContent(tab.content || '');
  return currentHash !== tab.lastSyncedHash;
}

/**
 * Create a tombstone for a deleted tab.
 *
 * @param {string} tabId - The ID of the deleted tab
 * @param {string} machineName - The machine that deleted it
 * @returns {object} Tombstone object
 */
function createTombstone(tabId, machineName) {
  return {
    id: tabId,
    deleted: true,
    deletedAt: new Date().toISOString(),
    deletedBy: machineName,
  };
}

/**
 * Mark a tab with sync metadata (updatedAt, updatedBy).
 * Call this whenever a tab is created or modified.
 *
 * @param {object} tab - The tab object
 * @param {string} machineName - The machine making the change
 * @returns {object} The tab with updated metadata
 */
function markTabUpdated(tab, machineName) {
  return {
    ...tab,
    updatedAt: new Date().toISOString(),
    updatedBy: machineName,
  };
}

/**
 * Purge tombstones older than the TTL.
 *
 * @param {Array} tabs - Array of tabs (including tombstones)
 * @param {number} ttlDays - Days to keep tombstones (default: 30)
 * @returns {Array} Filtered array with stale tombstones removed
 */
function purgeStaleTombstones(tabs, ttlDays = TOMBSTONE_TTL_DAYS) {
  const cutoffMs = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);

  return tabs.filter(tab => {
    if (!tab.deleted) {
      return true;
    }

    const deletedAtMs = new Date(tab.deletedAt || 0).getTime();
    return deletedAtMs > cutoffMs;
  });
}

/**
 * Check if a tab is a tombstone.
 *
 * @param {object} tab
 * @returns {boolean}
 */
function isTombstone(tab) {
  return tab && tab.deleted === true;
}

/**
 * Get only live (non-tombstone) tabs.
 *
 * @param {Array} tabs
 * @returns {Array}
 */
function getLiveTabs(tabs) {
  return tabs.filter(tab => !isTombstone(tab));
}

/**
 * Compute a simple content hash for change detection.
 *
 * @param {string} content
 * @returns {number}
 */
function hashContent(content) {
  if (window.padMerge?.fnv1a32) {
    return window.padMerge.fnv1a32(content);
  }

  // Simple hash fallback
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Prepare a snapshot for saving with sync metadata.
 * Ensures all tabs have updatedAt/updatedBy fields.
 * Also updates lastSyncedHash to mark current content as synced.
 *
 * @param {object} state - Current app state
 * @param {string} machineName - This machine's name
 * @returns {object} Snapshot ready for saving
 */
function prepareSnapshotForSync(state, machineName) {
  const now = new Date().toISOString();

  const tabs = state.tabs.map(tab => {
    // Preserve tombstones as-is
    if (tab.deleted) {
      return tab;
    }

    const currentContentHash = hashContent(tab.content || '');

    // Add/update sync metadata
    // Set lastSyncedHash to current content hash - this marks the content as "synced"
    return {
      ...tab,
      updatedAt: tab.updatedAt || now,
      updatedBy: tab.updatedBy || machineName,
      contentHash: currentContentHash,
      lastSyncedHash: currentContentHash,
    };
  });

  return {
    tabs,
    activeTabId: state.activeTabId,
    nextTabNumber: state.nextTabNumber,
    tabsExpanded: state.tabsExpanded,
    groups: state.groups,
    activeGroupId: state.activeGroupId,
    nextGroupNumber: state.nextGroupNumber,
    // Sync metadata
    machineName,
    savedAt: now,
    schemaVersion: 1,
  };
}

/**
 * Apply merged state back to local state.
 * Handles conflicts by storing them for manual resolution.
 *
 * @param {object} currentState - Current local state
 * @param {{mergedTabs: Array, conflicts: Array, tombstones: Array}} mergeResult
 * @returns {{
 *   newState: object,
 *   hasConflicts: boolean,
 *   conflictDetails: Array
 * }}
 */
function applyMergeResult(currentState, mergeResult) {
  const { mergedTabs, conflicts, tombstones } = mergeResult;

  // Keep tombstones in the tab list (they'll be filtered for display)
  const allTabs = [...mergedTabs, ...tombstones];

  // Purge old tombstones
  const prunedTabs = purgeStaleTombstones(allTabs);

  // Preserve active tab if it still exists and isn't deleted
  const activeTab = prunedTabs.find(t => t.id === currentState.activeTabId && !t.deleted);
  const newActiveTabId = activeTab
    ? currentState.activeTabId
    : getLiveTabs(prunedTabs)[0]?.id ?? null;

  return {
    newState: {
      ...currentState,
      tabs: prunedTabs,
      activeTabId: newActiveTabId,
    },
    hasConflicts: conflicts.length > 0,
    conflictDetails: conflicts,
  };
}

// Export for use in renderer
window.padSyncMerge = Object.freeze({
  mergeAllMachines,
  createTombstone,
  markTabUpdated,
  purgeStaleTombstones,
  isTombstone,
  getLiveTabs,
  hashContent,
  hasChangedSinceLastSync,
  prepareSnapshotForSync,
  applyMergeResult,
  TOMBSTONE_TTL_DAYS,
});
