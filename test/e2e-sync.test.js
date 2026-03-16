/**
 * E2E Sync Test - Simulates 3 machines syncing via a shared folder.
 *
 * This test doesn't launch actual Electron instances, but simulates
 * the sync behavior by directly manipulating snapshot files.
 *
 * Run with: npm run test:e2e
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Create temp directory for sync tests
const TEST_SYNC_FOLDER = path.join(os.tmpdir(), `pad-sync-test-${Date.now()}`);

// Load sync-merge module
global.window = { padMerge: null };
eval(fs.readFileSync(path.join(__dirname, '../sync-merge.js'), 'utf8'));
const syncMerge = global.window.padSyncMerge;

// Test state
let testCount = 0;
let passCount = 0;
let failCount = 0;

// Machine simulators
class MachineSimulator {
  constructor(name) {
    this.name = name;
    this.state = {
      tabs: [],
      activeTabId: null,
      nextTabNumber: 1,
      groups: [{ id: 'group-1', name: 'Group 1', tabIds: [] }],
      activeGroupId: 'group-1',
      nextGroupNumber: 2,
    };
  }

  createTab(content) {
    const id = `tab-${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tab = {
      id,
      title: content.slice(0, 20) || `Tab ${this.state.nextTabNumber}`,
      fallbackTitle: `Tab ${this.state.nextTabNumber}`,
      content,
      updatedAt: new Date().toISOString(),
      updatedBy: this.name,
    };
    this.state.tabs.push(tab);
    this.state.groups[0].tabIds.push(id);
    this.state.activeTabId = id;
    this.state.nextTabNumber++;
    return tab;
  }

  updateTab(tabId, content) {
    const tab = this.state.tabs.find(t => t.id === tabId && !t.deleted);
    if (!tab) return null;
    tab.content = content;
    tab.updatedAt = new Date().toISOString();
    tab.updatedBy = this.name;
    return tab;
  }

  deleteTab(tabId) {
    const idx = this.state.tabs.findIndex(t => t.id === tabId && !t.deleted);
    if (idx === -1) return null;

    const tombstone = syncMerge.createTombstone(tabId, this.name);
    this.state.tabs.splice(idx, 1, tombstone);

    // Remove from group
    for (const group of this.state.groups) {
      const gidx = group.tabIds.indexOf(tabId);
      if (gidx !== -1) {
        group.tabIds.splice(gidx, 1);
        break;
      }
    }

    return tombstone;
  }

  saveSnapshot() {
    const snapshot = syncMerge.prepareSnapshotForSync(this.state, this.name);
    const filePath = path.join(TEST_SYNC_FOLDER, `save_${this.name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    return filePath;
  }

  loadAndMerge() {
    // Read all snapshots from sync folder
    const files = fs.readdirSync(TEST_SYNC_FOLDER)
      .filter(f => f.startsWith('save_') && f.endsWith('.json'));

    const snapshots = files.map(file => {
      const content = fs.readFileSync(path.join(TEST_SYNC_FOLDER, file), 'utf8');
      const snapshot = JSON.parse(content);
      const machineName = file.replace(/^save_/, '').replace(/\.json$/, '');
      return { machineName, snapshot };
    });

    if (snapshots.length < 2) {
      return { changed: false };
    }

    const result = syncMerge.mergeAllMachines(snapshots);

    // Apply merge result to local state
    const currentIds = new Set(this.state.tabs.map(t => t.id));
    let changed = false;

    // Add new tabs from other machines
    for (const tab of result.mergedTabs) {
      if (!currentIds.has(tab.id) && !tab.deleted) {
        this.state.tabs.push(tab);
        if (!this.state.groups[0].tabIds.includes(tab.id)) {
          this.state.groups[0].tabIds.push(tab.id);
        }
        changed = true;
      }
    }

    // Apply tombstones
    for (const tombstone of result.tombstones) {
      const localTab = this.state.tabs.find(t => t.id === tombstone.id && !t.deleted);
      if (localTab) {
        const localTime = new Date(localTab.updatedAt || 0).getTime();
        const tombstoneTime = new Date(tombstone.deletedAt || 0).getTime();
        if (tombstoneTime > localTime) {
          const idx = this.state.tabs.indexOf(localTab);
          this.state.tabs.splice(idx, 1, tombstone);
          for (const group of this.state.groups) {
            const gidx = group.tabIds.indexOf(tombstone.id);
            if (gidx !== -1) group.tabIds.splice(gidx, 1);
          }
          changed = true;
        }
      }
    }

    // Update tabs with newer versions
    for (const remoteTab of result.mergedTabs) {
      if (remoteTab.deleted) continue;
      const localTab = this.state.tabs.find(t => t.id === remoteTab.id && !t.deleted);
      if (localTab && remoteTab.updatedBy !== this.name) {
        const localTime = new Date(localTab.updatedAt || 0).getTime();
        const remoteTime = new Date(remoteTab.updatedAt || 0).getTime();
        if (remoteTime > localTime) {
          Object.assign(localTab, remoteTab);
          changed = true;
        }
      }
    }

    // Purge old tombstones
    this.state.tabs = syncMerge.purgeStaleTombstones(this.state.tabs);

    return { changed, conflicts: result.conflicts };
  }

  getLiveTabs() {
    return this.state.tabs.filter(t => !t.deleted);
  }
}

// Test utilities
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
    throw new Error(`${msg}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('\n🔄 E2E Sync Tests\n');
  console.log(`Sync folder: ${TEST_SYNC_FOLDER}\n`);

  // Setup
  fs.mkdirSync(TEST_SYNC_FOLDER, { recursive: true });

  // Create 3 machine simulators
  let machineA, machineB, machineC;

  // --------------------------------------------
  console.log('▸ Scenario: Create and Sync');
  // --------------------------------------------

  machineA = new MachineSimulator('machineA');
  machineB = new MachineSimulator('machineB');
  machineC = new MachineSimulator('machineC');

  test('Machine A creates a tab', () => {
    const tab = machineA.createTab('Hello from A');
    assertEqual(tab.content, 'Hello from A');
    assertEqual(tab.updatedBy, 'machineA');
  });

  test('Machine A saves snapshot', () => {
    const filePath = machineA.saveSnapshot();
    assertEqual(fs.existsSync(filePath), true);
  });

  test('Machine B syncs and gets A\'s tab', () => {
    machineB.saveSnapshot();
    const result = machineB.loadAndMerge();
    assertEqual(result.changed, true);
    assertEqual(machineB.getLiveTabs().length, 1);
    assertEqual(machineB.getLiveTabs()[0].content, 'Hello from A');
  });

  test('Machine C syncs and gets A\'s tab', () => {
    machineC.saveSnapshot();
    const result = machineC.loadAndMerge();
    assertEqual(result.changed, true);
    assertEqual(machineC.getLiveTabs().length, 1);
  });

  // --------------------------------------------
  console.log('\n▸ Scenario: Multiple Creates');
  // --------------------------------------------

  // Reset
  fs.rmSync(TEST_SYNC_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(TEST_SYNC_FOLDER, { recursive: true });
  machineA = new MachineSimulator('machineA');
  machineB = new MachineSimulator('machineB');
  machineC = new MachineSimulator('machineC');

  test('All machines create tabs', () => {
    machineA.createTab('Tab from A');
    machineB.createTab('Tab from B');
    machineC.createTab('Tab from C');

    machineA.saveSnapshot();
    machineB.saveSnapshot();
    machineC.saveSnapshot();
  });

  test('All machines sync and have all 3 tabs', () => {
    machineA.loadAndMerge();
    machineB.loadAndMerge();
    machineC.loadAndMerge();

    assertEqual(machineA.getLiveTabs().length, 3);
    assertEqual(machineB.getLiveTabs().length, 3);
    assertEqual(machineC.getLiveTabs().length, 3);
  });

  // --------------------------------------------
  console.log('\n▸ Scenario: Update and Sync');
  // --------------------------------------------

  test('Machine A updates its tab', async () => {
    const tab = machineA.getLiveTabs().find(t => t.updatedBy === 'machineA');
    await sleep(10); // Ensure timestamp difference
    machineA.updateTab(tab.id, 'Updated by A');
    machineA.saveSnapshot();

    machineB.loadAndMerge();
    const bTab = machineB.getLiveTabs().find(t => t.id === tab.id);
    assertEqual(bTab.content, 'Updated by A');
  });

  // --------------------------------------------
  console.log('\n▸ Scenario: Delete and Sync');
  // --------------------------------------------

  test('Machine B deletes a tab, others sync', async () => {
    const countBefore = machineA.getLiveTabs().length;
    const tabToDelete = machineB.getLiveTabs().find(t => t.updatedBy === 'machineB');

    await sleep(10);
    machineB.deleteTab(tabToDelete.id);
    machineB.saveSnapshot();

    machineA.loadAndMerge();
    machineA.saveSnapshot();

    assertEqual(machineA.getLiveTabs().length, countBefore - 1, 'A should have one less tab');
  });

  // --------------------------------------------
  console.log('\n▸ Scenario: Resurrection');
  // --------------------------------------------

  // Reset
  fs.rmSync(TEST_SYNC_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(TEST_SYNC_FOLDER, { recursive: true });
  machineA = new MachineSimulator('machineA');
  machineB = new MachineSimulator('machineB');

  test('Tab resurrection: edit after delete wins', async () => {
    // A creates tab
    const tab = machineA.createTab('Original content');
    machineA.saveSnapshot();

    // B syncs
    machineB.loadAndMerge();
    machineB.saveSnapshot();

    await sleep(10);

    // A deletes
    machineA.deleteTab(tab.id);
    machineA.saveSnapshot();

    await sleep(50); // Ensure significant time gap

    // B edits (doesn't know about delete yet)
    machineB.updateTab(tab.id, 'Resurrected content');
    machineB.saveSnapshot();

    // A syncs - should see resurrection
    machineA.loadAndMerge();

    const resurrected = machineA.getLiveTabs().find(t => t.id === tab.id);
    assertEqual(resurrected !== undefined, true, 'Tab should be resurrected');
    assertEqual(resurrected?.content, 'Resurrected content');
  });

  // Cleanup
  fs.rmSync(TEST_SYNC_FOLDER, { recursive: true, force: true });

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`Tests: ${testCount} | Passed: ${passCount} | Failed: ${failCount}`);
  console.log('='.repeat(50));

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
