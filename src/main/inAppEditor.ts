import { BrowserWindow, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

let editorIpcReady = false;

/** Register IPC handlers for the in-app file editor (once). */
function ensureEditorIpc(rootDir: string): void {
  if (editorIpcReady) return;
  editorIpcReady = true;
  ipcMain.handle('fc-editor-save', (_e, payload: { path?: string; content?: string }) => {
    const path = resolve(String(payload?.path ?? ''));
    const content = String(payload?.content ?? '');
    const root = resolve(rootDir);
    if (path !== root && !path.startsWith(root + '/')) throw new Error('Path is outside the allowed directory.');
    writeFileSync(path, content, 'utf8');
    return { ok: true };
  });
}

/** Open a file in FortressChat instead of the system default editor. */
export function openInAppEditor(rootDir: string, absPath: string, startLine?: number): void {
  ensureEditorIpc(rootDir);
  let content = '';
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    content = '/* This file could not be opened as UTF-8 text. */';
  }
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: basename(absPath),
    webPreferences: {
      preload: join(__dirname, '..', 'src', 'preload-editor.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(join(__dirname, '..', 'assets', 'in-app', 'editor.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('fc-editor', { type: 'load', path: absPath, startLine: startLine ?? 1, content });
  });
}
