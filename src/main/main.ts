import { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ensureDaemon } from '../../vendor/fortress-code/packages/extension/src/daemon';
import { ChatController } from './controller';
import { SecretStore } from './secrets';
import { FileMemento } from './fileMemento';

let controller: ChatController | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100, height: 800, title: 'Fortress Code',
    webPreferences: { preload: join(__dirname, '..', 'src', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void win.loadFile(join(__dirname, '..', 'renderer', 'chat.html'));
  return win;
}

app.whenReady().then(async () => {
  const win = createWindow();
  const userDataDir = app.getPath('userData');
  const settings = new FileMemento(join(userDataDir, 'settings.json'));
  const secrets = new SecretStore(join(userDataDir, 'secrets.json'), safeStorage);
  controller = new ChatController({
    userDataDir,
    connect: () => ensureDaemon(join(__dirname, 'manager', 'index.js')),
    post: (m) => win.webContents.send('fc', m),
    openPath: async (p) => { await shell.openPath(p); },
    saveFile: async (defaultName, content) => {
      const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (r.filePath) writeFileSync(r.filePath, content, 'utf8');
    },
    secrets,
  });
  controller.setDevMode(Boolean(settings.get('fortressCode.devMode')));
  ipcMain.on('fc', (_e, m) => void controller!.onMessage(m));
  win.webContents.on('did-finish-load', () => void controller!.init());
  const last = settings.get('fortressCode.folder');
  if (typeof last === 'string') { controller.setFolder(last); win.setTitle(`Fortress Code — ${last}`); }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        const root = r.filePaths[0];
        if (root) { controller!.setFolder(root); settings.update('fortressCode.folder', root); win.setTitle(`Fortress Code — ${root}`); }
      } },
      { role: 'close' },
    ] },
    { label: 'Fortress', submenu: [
      { label: 'Developer Mode (bypasses US-only governance)', accelerator: 'Ctrl+Alt+M', click: async () => {
        const on = !settings.get('fortressCode.devMode');
        if (on) {
          const c = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Enable', 'Cancel'], defaultId: 1,
            message: 'Developer Mode bypasses the US-only governance and lets you use any Fireworks model (including non-US). Continue?' });
          if (c.response !== 0) return;
        }
        settings.update('fortressCode.devMode', on);
        controller!.setDevMode(on);
      } },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));

  if (process.argv.includes('--smoke')) {
    // Smoke: daemon reachable through the app's own spawn path, then exit 0.
    try {
      const client = await ensureDaemon(join(__dirname, 'manager', 'index.js'));
      await client.status();
      console.log('SMOKE OK');
      app.exit(0);
    } catch (e) { console.error('SMOKE FAIL', e); app.exit(1); }
  }
});

app.on('window-all-closed', () => { controller?.dispose(); app.quit(); });
