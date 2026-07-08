import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, clipboard } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ensureDaemon } from '../../vendor/fortress-code/packages/extension/src/daemon';
import { DEFAULT_SKILL_DIRS } from '../../vendor/fortress-code/packages/extension/src/skills';
import { ChatController } from './controller';
import { SecretStore } from './secrets';
import { FileMemento } from './fileMemento';
import { openInAppEditor } from './inAppEditor';
import { openInAppTerminal } from './inAppTerminal';
import { defaultModelsDirectory, getModelsDirectory, isModelsDirectoryConfirmed, markModelsDirectoryConfirmed, syncModelsDirectoryConfig } from './modelsDirectory';

const MCP_KEY = 'fortressCode.mcpServers';
const SKILL_DIRS_KEY = 'fortressCode.skillDirectories';

let controller: ChatController | null = null;
let mainWindow: BrowserWindow | null = null;
let panelWindow: BrowserWindow | null = null;

function settingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json');
}

/** Ensure default MCP/skills keys exist in settings.json. */
function ensureDefaultSettings(settings: FileMemento): void {
  if (!settings.get(MCP_KEY)) settings.update(MCP_KEY, []);
  if (!settings.get(SKILL_DIRS_KEY)) settings.update(SKILL_DIRS_KEY, [...DEFAULT_SKILL_DIRS]);
}

function broadcast(msg: unknown): void {
  mainWindow?.webContents.send('fc', msg);
  panelWindow?.webContents.send('fc', msg);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100, height: 800, title: 'Fortress Code',
    webPreferences: { preload: join(__dirname, '..', 'src', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void win.loadFile(join(__dirname, '..', 'renderer', 'chat.html'));
  return win;
}

function openPanelWindow(): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.focus();
    return;
  }
  panelWindow = createWindow();
  panelWindow.setTitle('Fortress Code — Chat');
  panelWindow.on('closed', () => { panelWindow = null; });
  panelWindow.webContents.on('did-finish-load', () => void controller?.init());
}

/** Open MCP/skills settings inside the chat panel instead of an external editor. */
function openSettingsPanel(section: 'mcp' | 'skills' = 'mcp'): void {
  broadcast({ type: 'openSettingsPanel', section });
  mainWindow?.focus();
}

app.whenReady().then(async () => {
  mainWindow = createWindow();
  const userDataDir = app.getPath('userData');
  const settings = new FileMemento(settingsPath(userDataDir));
  ensureDefaultSettings(settings);
  const secrets = new SecretStore(join(userDataDir, 'secrets.json'), safeStorage);

  controller = new ChatController({
    userDataDir,
    settings,
    connect: () => ensureDaemon(join(__dirname, 'manager', 'index.js')),
    post: broadcast,
    openPath: async (absPath) => {
      const root = controller?.folder;
      if (!root) return;
      openInAppEditor(root, absPath);
    },
    saveFile: async (defaultName, content) => {
      const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (r.filePath) writeFileSync(r.filePath, content, 'utf8');
    },
    secrets,
    pickDocuments: async () => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Documents', extensions: ['txt', 'md', 'markdown', 'json', 'csv', 'pdf'] }],
      });
      return r.filePaths;
    },
    pickImage: async () => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      });
      const path = r.filePaths[0];
      if (!path) return null;
      const buf = readFileSync(path);
      const ext = path.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      return { mime, base64: buf.toString('base64'), name: path.split('/').pop() ?? 'image' };
    },
    pickModelsDirectory: async () => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose local models folder',
        defaultPath: getModelsDirectory(settings) || defaultModelsDirectory(),
        message: 'Downloaded GGUF models are stored here.',
      });
      return r.filePaths[0] ?? null;
    },
    confirmDeleteModel: async (displayName) => {
      const r = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Delete model',
        message: `Delete ${displayName} from this Mac?`,
        detail: 'This frees disk space. You can download the model again later.',
      });
      return r.response === 0;
    },
    confirmModelsStorage: async () => {
      if (isModelsDirectoryConfirmed(settings)) {
        return { ok: true as const, dir: getModelsDirectory(settings) };
      }
      const def = defaultModelsDirectory();
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        buttons: ['Use Default Location', 'Choose Folder…', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Models storage location',
        message: 'Where should FortressChat store downloaded models?',
        detail: `Default folder:\n${def}\n\nYou can change this later in Settings → Local models.`,
      });
      if (response === 2) return { ok: false as const };
      if (response === 0) {
        markModelsDirectoryConfirmed(settings);
        syncModelsDirectoryConfig(settings);
        return { ok: true as const, dir: '' };
      }
      const picker = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose local models folder',
        defaultPath: def,
        message: 'Downloaded GGUF models will be saved in this folder.',
      });
      const dir = picker.filePaths[0];
      if (!dir) return { ok: false as const };
      return { ok: true as const, dir };
    },
    approveEdit: async (rel, isNew) => {
      const r = await dialog.showMessageBox(mainWindow!, {
        type: 'question', buttons: ['Apply', 'Reject'], defaultId: 0, cancelId: 1,
        message: `${isNew ? 'Create' : 'Edit'} ${rel}?`,
        detail: 'Fortress Code agent wants to change this file.',
      });
      return r.response === 0;
    },
    approveCommand: async (command) => {
      const r = await dialog.showMessageBox(mainWindow!, {
        type: 'warning', buttons: ['Run', 'Reject'], defaultId: 1, cancelId: 1,
        message: 'Fortress Code wants to run a shell command',
        detail: command,
      });
      return r.response === 0;
    },
    writeClipboard: (text) => { clipboard.writeText(text); },
    openChatPanel: openPanelWindow,
    openSettingsPanel,
    showInfo: (message) => { void dialog.showMessageBox(mainWindow!, { type: 'info', message }); },
    policyFatal: (message) => {
      dialog.showErrorBox('FortressChat — not allowed', message);
      app.exit(1);
    },
  });

  controller.setDevMode(false);
  ipcMain.on('fc', (_e, m) => void controller!.onMessage(m));
  mainWindow.webContents.on('did-finish-load', () => {
    const last = settings.get('fortressCode.folder');
    if (typeof last === 'string') {
      controller!.setFolder(last);
      mainWindow!.setTitle(`Fortress Code — ${last}`);
    }
    void controller!.init();
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: async () => {
        const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
        const root = r.filePaths[0];
        if (root) { controller!.setFolder(root); settings.update('fortressCode.folder', root); mainWindow!.setTitle(`Fortress Code — ${root}`); }
      } },
      { label: 'Choose Models Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void controller?.onMessage({ type: 'pickModelsDirectory' }) },
      { label: 'Use Default Models Folder', click: () => void controller?.onMessage({ type: 'clearModelsDirectory' }) },
      { type: 'separator' },
      { role: 'close' },
    ] },
    { label: 'Shell', submenu: [
      { label: 'New Terminal', accelerator: 'CmdOrCtrl+`', click: () => openInAppTerminal(controller?.folder) },
    ] },
    { label: 'Fortress', submenu: [
      { label: 'Developer Mode (disabled — local US models only)', accelerator: 'Ctrl+Alt+M', click: () => {
        dialog.showErrorBox('FortressChat — not allowed', 'Developer mode is disabled. FortressChat supports local US models only.');
      } },
      { label: 'Edit Settings (MCP + Skills)…', click: () => openSettingsPanel('mcp') },
      { label: 'Unload All Models', click: () => void controller?.onMessage({ type: 'unloadModels' }) },
      { label: 'Reload MCP Servers', click: () => void controller?.onMessage({ type: 'reloadMcp' }) },
      { label: 'Reload Skills', click: () => void controller?.onMessage({ type: 'reloadSkills' }) },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));

  if (process.argv.includes('--smoke')) {
    try {
      const client = await ensureDaemon(join(__dirname, 'manager', 'index.js'));
      await client.status();
      console.log('SMOKE OK');
      app.exit(0);
    } catch (e) { console.error('SMOKE FAIL', e); app.exit(1); }
  }
});

app.on('window-all-closed', () => { controller?.dispose(); app.quit(); });
