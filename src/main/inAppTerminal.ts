import { BrowserWindow, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

type TermSession = { proc: ChildProcessWithoutNullStreams; win: BrowserWindow };

const sessions = new Map<string, TermSession>();
let termIpcReady = false;
let nextId = 1;

/** Register IPC handlers for in-app terminal sessions (once). */
function ensureTerminalIpc(): void {
  if (termIpcReady) return;
  termIpcReady = true;

  ipcMain.handle('fc-term-create', (event, payload: { cwd?: string }) => {
    const id = String(nextId++);
    const cwd = payload?.cwd && payload.cwd.length ? payload.cwd : homedir();
    const shell = process.env.SHELL || '/bin/zsh';
    const win = BrowserWindow.fromWebContents(event.sender);
    const proc = spawn('script', ['-q', '/dev/null', shell, '-l'], {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: TermSession = { proc, win: win! };
    proc.stdout.on('data', (buf) => {
      win?.webContents.send('fc-term-data', { id, data: buf.toString('utf8') });
    });
    proc.stderr.on('data', (buf) => {
      win?.webContents.send('fc-term-data', { id, data: buf.toString('utf8') });
    });
    proc.on('exit', () => {
      win?.webContents.send('fc-term-exit', { id });
      sessions.delete(id);
    });
    sessions.set(id, session);
    return { id, cwd, shell };
  });

  ipcMain.on('fc-term-write', (_e, payload: { id?: string; data?: string }) => {
    const session = sessions.get(String(payload?.id ?? ''));
    if (!session) return;
    session.proc.stdin.write(String(payload?.data ?? ''));
  });

  ipcMain.on('fc-term-kill', (_e, payload: { id?: string }) => {
    const id = String(payload?.id ?? '');
    const session = sessions.get(id);
    if (!session) return;
    session.proc.kill();
    sessions.delete(id);
  });
}

/** Open a new integrated terminal window rooted in the workspace folder. */
export function openInAppTerminal(cwd?: string | null): void {
  ensureTerminalIpc();
  const win = new BrowserWindow({
    width: 900,
    height: 560,
    title: 'FortressChat — Terminal',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '..', 'src', 'preload-terminal.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(join(__dirname, '..', 'assets', 'in-app', 'terminal.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('fc-term-init', { cwd: cwd ?? homedir() });
  });
  win.on('closed', () => {
    for (const [id, session] of sessions) {
      if (session.win === win) {
        session.proc.kill();
        sessions.delete(id);
      }
    }
  });
}
