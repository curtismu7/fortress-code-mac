import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('macMediaPatch', () => {
  it('passes when Mac explorer UI is present', () => {
    expect(execSync('node scripts/mac-media-patch.mjs', { encoding: 'utf8' })).toContain('Mac media patch OK');
    const html = readFileSync(join(process.cwd(), 'assets/chat-media/chat.html'), 'utf8');
    expect(html).toContain('id="file-explorer"');
    const js = readFileSync(join(process.cwd(), 'assets/chat-media/chat.js'), 'utf8');
    expect(js).toContain('renderWorkspaceExplorer');
  });
});
