const { app, BrowserWindow, dialog, Menu, ipcMain } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { createBackupManager } = require('./backup');

const isMac = process.platform === 'darwin';

let mainWindow = null;
const backupManager = createBackupManager({ app });
const AUTO_BACKUP_INTERVAL_MINUTES = 1;

async function openFileDialog(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(targetWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Text Files', extensions: ['txt', 'md', 'text'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (canceled || !filePaths || filePaths.length === 0) {
      return;
    }

    const filePath = filePaths[0];
    const content = await fs.readFile(filePath, 'utf8');

    if (targetWindow.isDestroyed()) {
      return;
    }

    targetWindow.webContents.send('pad:file-opened', {
      content,
      fileName: path.basename(filePath),
    });
  } catch (error) {
    console.error('Failed to open file', error);
  }
}

function buildMenu(backups = []) {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: (_, browserWindow) => {
            const targetWindow = browserWindow ?? BrowserWindow.getFocusedWindow();
            if (targetWindow) {
              openFileDialog(targetWindow);
            }
          },
        },
        ...(isMac ? [{ role: 'close' }] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Backup',
      submenu: [
        {
          label: 'Create Backup',
          click: async (_menuItem, browserWindow) => {
            const targetWindow =
              browserWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            await handleBackupRequest(targetWindow);
          },
        },
        { type: 'separator' },
        {
          label: 'Choose Backup Folder…',
          click: async (_menuItem, browserWindow) => {
            const targetWindow =
              browserWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            await handleChooseBackupFolderRequest(targetWindow);
          },
        },
        { type: 'separator' },
        ...(backups.length
          ? backups.map(entry => ({
              label: `Restore ${entry.displayName}`,
              click: async (_menuItem, browserWindow) => {
                const targetWindow =
                  browserWindow ??
                  BrowserWindow.getFocusedWindow() ??
                  BrowserWindow.getAllWindows()[0];
                await handleRestoreRequest(targetWindow, entry.path);
              },
            }))
          : [{ label: 'No backups yet', enabled: false }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.loadFile('index.html');
  mainWindow = window;
  return window;
}

app.whenReady().then(() => {
  createMainWindow();
  refreshMenu();
  registerSyncHandlers();
  registerBackupHandlers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});

function registerSyncHandlers() {
  ipcMain.handle('pad:save-snapshot', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid payload' };
    }

    const { folderPath, content } = payload;
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      return { ok: false, error: 'Missing folderPath' };
    }

    const safeFolder = path.resolve(folderPath);
    const fileName = `save_${os.hostname()}.json`;
    const targetPath = path.join(safeFolder, fileName);

    try {
      await fs.mkdir(safeFolder, { recursive: true });
      await fs.writeFile(targetPath, content, 'utf8');
      return { ok: true, path: targetPath };
    } catch (error) {
      console.error('Failed to write snapshot', error);
      return { ok: false, error: error.message };
    }
  });
}

async function handleBackupRequest(targetWindow) {
  const window = getTargetWindow(targetWindow);
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    const maxBackups = await getMaxBackupsSetting();
    const backupFolder = await getBackupFolderSetting();
    const options = { maxBackups };
    if (backupFolder) {
      options.directory = backupFolder;
    }
    const result = await backupManager.create(window, options);
    if (!result.ok) {
      throw new Error(result.error || 'Unknown error');
    }
    await refreshMenu();
    await dialog.showMessageBox(window, {
      type: 'info',
      message: 'Backup created',
      detail: `Saved to:\n${result.path}`,
    });
  } catch (error) {
    console.error('Failed to create backup', error);
    await dialog.showMessageBox(window, {
      type: 'error',
      message: 'Backup failed',
      detail: error.message,
    });
  }
}

async function handleRestoreRequest(targetWindow, backupPath) {
  const window = getTargetWindow(targetWindow);
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    const backupFolder = await getBackupFolderSetting();

    const safetyBackupResult = await backupManager.createRestoreSafetyBackup(window, {
      directory: backupFolder || undefined,
    });
    if (!safetyBackupResult.ok) {
      await dialog.showMessageBox(window, {
        type: 'error',
        message: 'Restore cancelled',
        detail: `Could not create restore safety backup:\n${safetyBackupResult.error}`,
      });
      return;
    }

    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message: 'Restore backup',
      detail:
        `A safety backup was created first:\n${safetyBackupResult.path}\n\n` +
        'How do you want to restore?',
      buttons: ['Merge', 'Replace', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });

    if (response === 2) {
      return;
    }

    if (response === 1) {
      const result = await backupManager.restore(window, backupPath);
      if (!result.ok) {
        throw new Error(result.error || 'Unknown error');
      }

      await refreshMenu();
      await dialog.showMessageBox(window, {
        type: 'info',
        message: 'Restore complete',
        detail: 'Local storage restored. Reloading your tabs.',
      });
      window.webContents.reload();
      return;
    }

    const raw = await fs.readFile(backupPath, 'utf8');
    const parsed = JSON.parse(raw);
    const storage = parsed?.storage;
    if (!storage || typeof storage !== 'object') {
      throw new Error('Backup file is missing storage content.');
    }

    window.webContents.send('pad:restore-merge', {
      storage,
      sourceBackupPath: backupPath,
      safetyBackupPath: safetyBackupResult.path,
    });
  } catch (error) {
    console.error('Failed to restore backup', error);
    await dialog.showMessageBox(window, {
      type: 'error',
      message: 'Restore failed',
      detail: error.message,
    });
  }
}

async function handleChooseBackupFolderRequest(targetWindow) {
  const window = getTargetWindow(targetWindow);
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    const currentFolder = await getBackupFolderSetting();
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: 'Choose Backup Folder',
      defaultPath: currentFolder || backupManager.getDefaultBackupDirectory(),
      properties: ['openDirectory'],
    });

    if (canceled || !filePaths || filePaths.length === 0) {
      return;
    }

    const folderPath = filePaths[0];
    await saveBackupFolderSetting(window, folderPath);
    await refreshMenu();

    await dialog.showMessageBox(window, {
      type: 'info',
      message: 'Backup folder updated',
      detail: `Backups will now be saved to:\n${folderPath}`,
    });
  } catch (error) {
    console.error('Failed to choose backup folder', error);
    await dialog.showMessageBox(window, {
      type: 'error',
      message: 'Failed to set backup folder',
      detail: error.message,
    });
  }
}

async function getBackupFolderSetting() {
  const window = getTargetWindow();
  if (!window || window.isDestroyed()) {
    return '';
  }

  try {
    const settings = await window.webContents.executeJavaScript('padAppSettings.getBackupSettings()');
    return settings?.folder || '';
  } catch {
    return '';
  }
}

async function saveBackupFolderSetting(window, folderPath) {
  const escaped = folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  await window.webContents.executeJavaScript(`padAppSettings.updateBackupSettings({ folder: '${escaped}' })`);
}

function registerBackupHandlers() {
  ipcMain.handle('pad:update-auto-backup', async () => {
    await updateAutoBackup();
    return { ok: true };
  });

  ipcMain.handle('pad:get-backup-settings', async () => {
    const maxBackups = await getMaxBackupsSetting();
    const autoBackup = await getAutoBackupSettings();
    return { maxBackups, autoBackup };
  });
}

async function updateAutoBackup() {
  const window = getTargetWindow();
  if (!window || window.isDestroyed()) {
    backupManager.stopAutoBackup();
    return;
  }

  const backupFolder = await getBackupFolderSetting();
  backupManager.startAutoBackup(window, AUTO_BACKUP_INTERVAL_MINUTES, backupFolder || null, () => {
    refreshMenu();
  });
}

async function getMaxBackupsSetting() {
  const window = getTargetWindow();
  if (!window || window.isDestroyed()) {
    return 10;
  }

  try {
    const settings = await window.webContents.executeJavaScript('padAppSettings.getBackupSettings()');
    return settings?.maxBackups ?? 10;
  } catch {
    return 10;
  }
}

async function getAutoBackupSettings() {
  return { enabled: true, intervalMinutes: AUTO_BACKUP_INTERVAL_MINUTES };
}

async function refreshMenu() {
  const backupFolder = await getBackupFolderSetting();
  const backups = await backupManager.list(backupFolder || null);
  buildMenu(backups);
}

function getTargetWindow(targetWindow) {
  if (targetWindow && !targetWindow.isDestroyed()) {
    return targetWindow;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}
