import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInWorkspace } from './macTools';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.venv', '__pycache__', '.next', 'build', 'coverage']);

export interface WorkspaceTreeEntry {
  name: string;
  rel: string;
  kind: 'file' | 'dir';
}

/** List one directory level under the workspace root for the file explorer. */
export function listWorkspaceDir(root: string, relDir: string): WorkspaceTreeEntry[] {
  const abs = resolveInWorkspace(root, relDir || '.');
  const st = statSync(abs);
  if (!st.isDirectory()) return [];

  const entries: WorkspaceTreeEntry[] = [];
  for (const name of readdirSync(abs)) {
    if (name === '.git' || IGNORE.has(name)) continue;
    const full = join(abs, name);
    let kind: 'file' | 'dir';
    try {
      kind = statSync(full).isDirectory() ? 'dir' : 'file';
    } catch {
      continue;
    }
    const rel = relDir ? join(relDir, name) : name;
    entries.push({ name, rel: rel.split('\\').join('/'), kind });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return entries;
}
