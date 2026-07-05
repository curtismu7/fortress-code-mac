import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncRenderer } from '../scripts/sync-renderer.mjs';

const VENDOR = 'vendor/fortress-code/packages/extension/media';

describe('syncRenderer', () => {
  it('copies chat.js and chat.css byte-identical and transforms chat.html', () => {
    const out = mkdtempSync(join(tmpdir(), 'fc-renderer-'));
    syncRenderer(VENDOR, out);
    expect(readFileSync(join(out, 'chat.js'))).toEqual(readFileSync(join(VENDOR, 'chat.js')));
    expect(readFileSync(join(out, 'chat.css'))).toEqual(readFileSync(join(VENDOR, 'chat.css')));
    const html = readFileSync(join(out, 'chat.html'), 'utf8');
    expect(html).not.toContain('{cspSource}');
    expect(html).toContain("style-src 'self' 'unsafe-inline'");
    expect(html.indexOf('vscode-shim.js')).toBeGreaterThan(-1);
    expect(html.indexOf('vscode-shim.js')).toBeLessThan(html.indexOf('chat.js')); // shim loads first
    expect(html).toContain('theme.css');
    expect(readFileSync(join(out, 'vscode-shim.js'), 'utf8')).toContain('acquireVsCodeApi');
    expect(readFileSync(join(out, 'theme.css'), 'utf8')).toContain('--vscode-foreground');
  });

  it('copies the vendor media subdirectory and keeps chat.js byte-identical', () => {
    const out = mkdtempSync(join(tmpdir(), 'fc-renderer-'));
    syncRenderer(VENDOR, out);
    expect(readFileSync(join(out, 'chat.js'))).toEqual(readFileSync(join(VENDOR, 'chat.js')));
    expect(readFileSync(join(out, 'vendor', 'katex.min.js'))).toEqual(readFileSync(join(VENDOR, 'vendor', 'katex.min.js')));
    expect(readFileSync(join(out, 'vendor', 'mermaid.min.js'))).toEqual(readFileSync(join(VENDOR, 'vendor', 'mermaid.min.js')));
  });
});
