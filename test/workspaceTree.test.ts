import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaceDir } from '../src/main/workspaceTree';

describe('listWorkspaceDir', () => {
  it('lists directories before files and skips ignored folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-tree-'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'README.md'), '# hi');

    const entries = listWorkspaceDir(root, '');
    expect(entries.map((e) => e.name)).toEqual(['src', 'README.md']);
    expect(entries[0]?.kind).toBe('dir');
    expect(entries[1]?.kind).toBe('file');
  });

  it('lists nested directories relative to the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-tree-'));
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'index.ts'), 'export {}');

    const entries = listWorkspaceDir(root, 'pkg');
    expect(entries).toEqual([{ name: 'index.ts', rel: 'pkg/index.ts', kind: 'file' }]);
  });
});
