/**
 * Tests for multi-machine sync with tombstones.
 *
 * Run with: node test/sync-merge.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Load sync-merge module (browser code, need to mock window)
global.window = { padMerge: null };
const syncMergeCode = fs.readFileSync(path.join(__dirname, '../sync-merge.js'), 'utf8');
eval(syncMergeCode);
const syncMerge = global.window.padSyncMerge;

// Test utilities
let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failCount++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n    Expected: ${JSON.stringify(expected)}\n    Actual: ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}\n    Expected: ${JSON.stringify(expected, null, 2)}\n    Actual: ${JSON.stringify(actual, null, 2)}`);
  }
}

function assertTrue(condition, msg = 'Expected true') {
  if (!condition) {
    throw new Error(msg);
  }
}

function assertFalse(condition, msg = 'Expected false') {
  if (condition) {
    throw new Error(msg);
  }
}

// Helper to create test tabs
function createTab(id, content, updatedAt, updatedBy, options = {}) {
  const tab = {
    id,
    title: content.slice(0, 20) || `Tab ${id}`,
    fallbackTitle: `Tab ${id}`,
    content,
    updatedAt: updatedAt || new Date().toISOString(),
    updatedBy: updatedBy || 'test',
  };
  // If lastSyncedHash is provided, set it (for testing sync state)
  if (options.lastSyncedHash !== undefined) {
    tab.lastSyncedHash = options.lastSyncedHash;
  }
  return tab;
}

function makeTestTombstone(id, deletedAt, deletedBy) {
  return {
    id,
    deleted: true,
    deletedAt: deletedAt || new Date().toISOString(),
    deletedBy: deletedBy || 'test',
  };
}

function createSnapshot(tabs, machineName) {
  return {
    tabs,
    activeTabId: tabs[0]?.id || null,
    nextTabNumber: tabs.length + 1,
    machineName,
    savedAt: new Date().toISOString(),
  };
}

// ============================================
// TEST SUITES
// ============================================

console.log('\n📦 sync-merge.js Tests\n');

// --------------------------------------------
console.log('▸ Basic Functions');
// --------------------------------------------

test('createTombstone creates valid tombstone', () => {
  const tombstone = syncMerge.createTombstone('tab-123', 'machineA');
  assertEqual(tombstone.id, 'tab-123');
  assertEqual(tombstone.deleted, true);
  assertEqual(tombstone.deletedBy, 'machineA');
  assertTrue(tombstone.deletedAt !== undefined, 'Should have deletedAt');
});

test('markTabUpdated adds sync metadata', () => {
  const tab = { id: 'tab-1', content: 'hello' };
  const updated = syncMerge.markTabUpdated(tab, 'machineB');
  assertEqual(updated.updatedBy, 'machineB');
  assertTrue(updated.updatedAt !== undefined, 'Should have updatedAt');
  assertEqual(updated.content, 'hello', 'Should preserve content');
});

test('isTombstone correctly identifies tombstones', () => {
  assertTrue(syncMerge.isTombstone({ id: '1', deleted: true }));
  assertFalse(syncMerge.isTombstone({ id: '1', content: 'hi' }));
  assertFalse(syncMerge.isTombstone(null));
});

test('getLiveTabs filters out tombstones', () => {
  const tabs = [
    createTab('1', 'live'),
    makeTestTombstone('2'),
    createTab('3', 'also live'),
  ];
  const live = syncMerge.getLiveTabs(tabs);
  assertEqual(live.length, 2);
  assertEqual(live[0].id, '1');
  assertEqual(live[1].id, '3');
});

// --------------------------------------------
console.log('\n▸ Tombstone Cleanup');
// --------------------------------------------

test('purgeStaleTombstones removes old tombstones', () => {
  const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const recentDate = new Date().toISOString();

  const tabs = [
    createTab('1', 'live'),
    makeTestTombstone('2', oldDate, 'machineA'),     // 31 days old - should be purged
    makeTestTombstone('3', recentDate, 'machineB'),  // recent - should stay
  ];

  const purged = syncMerge.purgeStaleTombstones(tabs, 30);
  assertEqual(purged.length, 2);
  assertEqual(purged[0].id, '1');
  assertEqual(purged[1].id, '3');
});

test('purgeStaleTombstones keeps tombstones within TTL', () => {
  const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const tabs = [
    makeTestTombstone('1', recentDate, 'machineA'),  // 5 days old
  ];

  const purged = syncMerge.purgeStaleTombstones(tabs, 30);
  assertEqual(purged.length, 1);
});

// --------------------------------------------
console.log('\n▸ Merge: Create Scenarios');
// --------------------------------------------

test('Scenario 1: Single machine creates tab', () => {
  const machineA = createSnapshot([createTab('tab-1', 'Hello from A', '2026-01-15T10:00:00Z', 'machineA')], 'machineA');
  const machineB = createSnapshot([], 'machineB');
  const machineC = createSnapshot([], 'machineC');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
    { machineName: 'machineC', snapshot: machineC },
  ]);

  assertEqual(result.mergedTabs.length, 1);
  assertEqual(result.mergedTabs[0].id, 'tab-1');
  assertEqual(result.mergedTabs[0].content, 'Hello from A');
  assertEqual(result.conflicts.length, 0);
});

test('Scenario 2: Multiple machines create different tabs', () => {
  const machineA = createSnapshot([createTab('tab-A', 'From A', '2026-01-15T10:00:00Z', 'machineA')], 'machineA');
  const machineB = createSnapshot([createTab('tab-B', 'From B', '2026-01-15T10:00:05Z', 'machineB')], 'machineB');
  const machineC = createSnapshot([createTab('tab-C', 'From C', '2026-01-15T10:00:10Z', 'machineC')], 'machineC');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
    { machineName: 'machineC', snapshot: machineC },
  ]);

  assertEqual(result.mergedTabs.length, 3);
  const ids = result.mergedTabs.map(t => t.id).sort();
  assertDeepEqual(ids, ['tab-A', 'tab-B', 'tab-C']);
  assertEqual(result.conflicts.length, 0);
});

// --------------------------------------------
console.log('\n▸ Merge: Update Scenarios');
// --------------------------------------------

test('Scenario 3: Single machine updates tab', () => {
  const tab = createTab('tab-1', 'Updated content', '2026-01-15T10:00:30Z', 'machineA');
  const oldTab = createTab('tab-1', 'Old content', '2026-01-15T10:00:00Z', 'machineA');

  const machineA = createSnapshot([tab], 'machineA');
  const machineB = createSnapshot([oldTab], 'machineB');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
  ]);

  assertEqual(result.mergedTabs.length, 1);
  assertEqual(result.mergedTabs[0].content, 'Updated content', 'Should use newer version');
});

test('Scenario 4: Sequential updates - no conflict when synced', () => {
  // Machine A has content that matches its lastSyncedHash (no local changes)
  const contentHashA = syncMerge.hashContent('A version');
  const tabA = createTab('tab-1', 'A version', '2026-01-15T10:00:00Z', 'machineA', { lastSyncedHash: contentHashA });
  // Machine B has newer content that also matches its lastSyncedHash
  const contentHashB = syncMerge.hashContent('B version');
  const tabB = createTab('tab-1', 'B version', '2026-01-15T10:00:35Z', 'machineB', { lastSyncedHash: contentHashB });

  const machineA = createSnapshot([tabA], 'machineA');
  const machineB = createSnapshot([tabB], 'machineB');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
  ]);

  assertEqual(result.mergedTabs.length, 1);
  assertEqual(result.mergedTabs[0].content, 'B version', 'Should use B (newer)');
  // No conflict because both machines' content matches their lastSyncedHash
  // (neither has unsaved local changes)
  assertEqual(result.conflicts.length, 0, 'No conflict when both are synced');
});

test('Scenario 5: Concurrent updates - newest wins', () => {
  // Machine A edits at t=0
  const tabA = createTab('tab-1', 'A version', '2026-01-15T10:00:00Z', 'machineA');
  // Machine B edits at t=10s
  const tabB = createTab('tab-1', 'B version', '2026-01-15T10:00:10Z', 'machineB');

  const machineA = createSnapshot([tabA], 'machineA');
  const machineB = createSnapshot([tabB], 'machineB');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
  ]);

  assertEqual(result.mergedTabs.length, 1);
  assertEqual(result.mergedTabs[0].content, 'B version', 'Newest version wins');
  // Conflict detection is now handled in handleMergeResult based on local state
  assertEqual(result.conflicts.length, 0, 'mergeAllMachines does not detect conflicts');
});

test('No conflict if content is identical', () => {
  // Both machines have same content
  const tabA = createTab('tab-1', 'Same content', '2026-01-15T10:00:00Z', 'machineA');
  const tabB = createTab('tab-1', 'Same content', '2026-01-15T10:00:10Z', 'machineB');

  const machineA = createSnapshot([tabA], 'machineA');
  const machineB = createSnapshot([tabB], 'machineB');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
  ]);

  assertEqual(result.conflicts.length, 0, 'No conflict when content matches');
});

// --------------------------------------------
console.log('\n▸ Merge: Delete Scenarios');
// --------------------------------------------

test('Scenario 6: Single machine deletes tab', () => {
  const tombstone = makeTestTombstone('tab-1', '2026-01-15T10:00:30Z', 'machineA');
  const liveTab = createTab('tab-1', 'Live content', '2026-01-15T10:00:00Z', 'machineB');

  const machineA = createSnapshot([tombstone], 'machineA');
  const machineB = createSnapshot([liveTab], 'machineB');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
  ]);

  assertEqual(result.mergedTabs.length, 0, 'Tab should be deleted');
  assertEqual(result.tombstones.length, 1, 'Tombstone preserved');
  assertEqual(result.tombstones[0].id, 'tab-1');
});

test('Scenario 7: Delete after edit - tombstone wins', () => {
  // Machine B edits at t=0
  const liveTab = createTab('tab-1', 'Edited content', '2026-01-15T10:00:00Z', 'machineB');
  // Machine C deletes at t=5s
  const tombstone = makeTestTombstone('tab-1', '2026-01-15T10:00:05Z', 'machineC');

  const machineB = createSnapshot([liveTab], 'machineB');
  const machineC = createSnapshot([tombstone], 'machineC');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineB', snapshot: machineB },
    { machineName: 'machineC', snapshot: machineC },
  ]);

  assertEqual(result.mergedTabs.length, 0, 'Tab should be deleted (tombstone newer)');
  assertEqual(result.tombstones.length, 1);
});

test('Scenario 8: Delete before edit - tab resurrected', () => {
  // Machine A deletes at t=0
  const tombstone = makeTestTombstone('tab-1', '2026-01-15T10:00:00Z', 'machineA');
  // Machine B edits at t=35s
  const liveTab = createTab('tab-1', 'Resurrected content', '2026-01-15T10:00:35Z', 'machineB');

  const machineA = createSnapshot([tombstone], 'machineA');
  const machineB = createSnapshot([liveTab], 'machineB');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
  ]);

  assertEqual(result.mergedTabs.length, 1, 'Tab should be resurrected (edit newer)');
  assertEqual(result.mergedTabs[0].content, 'Resurrected content');
  assertEqual(result.tombstones.length, 0);
});

// --------------------------------------------
console.log('\n▸ Merge: 3-Machine Scenarios');
// --------------------------------------------

test('3 machines with mixed operations', () => {
  // Machine A: has tab-1, tab-2
  // Machine B: has tab-1 (updated), tab-3 (new)
  // Machine C: has tombstone for tab-2

  const machineA = createSnapshot([
    createTab('tab-1', 'Original', '2026-01-15T10:00:00Z', 'machineA'),
    createTab('tab-2', 'To be deleted', '2026-01-15T10:00:00Z', 'machineA'),
  ], 'machineA');

  const machineB = createSnapshot([
    createTab('tab-1', 'Updated by B', '2026-01-15T10:00:30Z', 'machineB'),
    createTab('tab-3', 'New from B', '2026-01-15T10:00:30Z', 'machineB'),
  ], 'machineB');

  const machineC = createSnapshot([
    makeTestTombstone('tab-2', '2026-01-15T10:00:15Z', 'machineC'),
  ], 'machineC');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
    { machineName: 'machineC', snapshot: machineC },
  ]);

  assertEqual(result.mergedTabs.length, 2, 'Should have tab-1 and tab-3');
  const ids = result.mergedTabs.map(t => t.id).sort();
  assertDeepEqual(ids, ['tab-1', 'tab-3']);

  const tab1 = result.mergedTabs.find(t => t.id === 'tab-1');
  assertEqual(tab1.content, 'Updated by B', 'tab-1 should have B\'s content');

  assertEqual(result.tombstones.length, 1, 'Should have tombstone for tab-2');
});

test('mergeAllMachines returns newest version without conflicts', () => {
  // mergeAllMachines just returns newest version - conflict detection is in handleMergeResult
  const tabA = createTab('tab-1', 'A version', '2026-01-15T10:00:00Z', 'machineA');
  const tabB = createTab('tab-1', 'B version', '2026-01-15T10:00:10Z', 'machineB');

  const machineA = createSnapshot([tabA], 'machineA');
  const machineB = createSnapshot([tabB], 'machineB');

  const result = syncMerge.mergeAllMachines([
    { machineName: 'machineA', snapshot: machineA },
    { machineName: 'machineB', snapshot: machineB },
  ]);

  assertEqual(result.mergedTabs.length, 1);
  assertEqual(result.mergedTabs[0].content, 'B version', 'Newest version wins');
  assertEqual(result.conflicts.length, 0, 'Conflicts are detected in handleMergeResult, not here');
});

// --------------------------------------------
console.log('\n▸ Snapshot Preparation');
// --------------------------------------------

test('prepareSnapshotForSync adds machine metadata', () => {
  const state = {
    tabs: [{ id: 'tab-1', content: 'Hello' }],
    activeTabId: 'tab-1',
    nextTabNumber: 2,
    groups: [],
    activeGroupId: null,
    nextGroupNumber: 1,
  };

  const snapshot = syncMerge.prepareSnapshotForSync(state, 'testMachine');

  assertEqual(snapshot.machineName, 'testMachine');
  assertTrue(snapshot.savedAt !== undefined, 'Should have savedAt');
  assertEqual(snapshot.schemaVersion, 1);
  assertTrue(snapshot.tabs[0].updatedAt !== undefined, 'Tab should have updatedAt');
  assertEqual(snapshot.tabs[0].updatedBy, 'testMachine');
});

test('prepareSnapshotForSync preserves existing timestamps', () => {
  const existingTime = '2026-01-10T10:00:00Z';
  const state = {
    tabs: [{
      id: 'tab-1',
      content: 'Hello',
      updatedAt: existingTime,
      updatedBy: 'originalMachine',
    }],
    activeTabId: 'tab-1',
    nextTabNumber: 2,
    groups: [],
  };

  const snapshot = syncMerge.prepareSnapshotForSync(state, 'newMachine');

  assertEqual(snapshot.tabs[0].updatedAt, existingTime, 'Should preserve existing timestamp');
  assertEqual(snapshot.tabs[0].updatedBy, 'originalMachine', 'Should preserve original author');
});

// --------------------------------------------
// Summary
// --------------------------------------------

console.log('\n' + '='.repeat(50));
console.log(`Tests: ${testCount} | Passed: ${passCount} | Failed: ${failCount}`);
console.log('='.repeat(50));

if (failCount > 0) {
  process.exit(1);
}
