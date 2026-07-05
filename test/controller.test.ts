import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatController } from '../src/main/controller';
import { SecretStore, OPENROUTER_KEY_ID } from '../src/main/secrets';

const backend = { encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), isEncryptionAvailable: () => true };

function makeDeps() {
  const posts: any[] = [];
  const userDataDir = mkdtempSync(join(tmpdir(), 'fc-app-'));
  const deps = {
    userDataDir,
    connect: vi.fn(async () => ({ status: async () => ({ state: 'idle', modelId: null, endpoint: null, download: null, crashLog: null, ram: { totalBytes: 1, availableBytes: 1 }, binaryInstalled: false, downloadedModelIds: [], downloadError: null, embed: { state: 'idle', modelId: null, endpoint: null } }) }) as any),
    post: (m: any) => posts.push(m),
    openPath: vi.fn(async () => {}),
    secrets: new SecretStore(join(userDataDir, 'secrets.json'), backend),
  };
  return { deps, posts };
}

describe('ChatController', () => {
  it('init posts policy, key state, dev mode, history, chats', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.init();
    const types = posts.map((p) => p.type);
    for (const t of ['policy', 'openRouterKeySet', 'devMode', 'history', 'chats']) expect(types).toContain(t);
    c.dispose();
  });

  it('setOpenRouterKey stores the key and confirms', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'setOpenRouterKey', key: 'sk-or-xyz' });
    expect(deps.secrets.get(OPENROUTER_KEY_ID)).toBe('sk-or-xyz');
    expect(posts.at(-1)).toEqual({ type: 'openRouterKeySet', set: true });
    c.dispose();
  });

  it('send without a model banners and restores input', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'send', text: 'hi' });
    expect(posts.some((p) => p.type === 'error' && /model/i.test(p.message))).toBe(true);
    expect(posts.some((p) => p.type === 'restoreInput' && p.text === 'hi')).toBe(true);
    c.dispose();
  });

  it('openSource validates the path and calls openPath inside the folder only', async () => {
    const { deps } = makeDeps();
    const c = new ChatController(deps);
    const root = mkdtempSync(join(tmpdir(), 'fc-root-'));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'a.ts'), 'x');
    c.setFolder(root);
    await c.onMessage({ type: 'openSource', file: 'src/a.ts', startLine: 1, endLine: 1 });
    expect(deps.openPath).toHaveBeenCalledWith(join(root, 'src', 'a.ts'));
    (deps.openPath as any).mockClear();
    await c.onMessage({ type: 'openSource', file: '../../etc/passwd', startLine: 1, endLine: 1 });
    expect(deps.openPath).not.toHaveBeenCalled();
    c.dispose();
  });

  it('insertCode banners not-available; agentToggle is a no-op', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'insertCode', code: 'x' });
    expect(posts.some((p) => p.type === 'error' && /not available/i.test(p.message))).toBe(true);
    await c.onMessage({ type: 'agentToggle', on: true }); // must not throw or post an error
    c.dispose();
  });
});
