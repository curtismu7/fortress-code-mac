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
  const saveFile = vi.fn(async () => {});
  const deps = {
    userDataDir,
    connect: vi.fn(async () => ({ status: async () => ({ state: 'idle', modelId: null, endpoint: null, download: null, crashLog: null, ram: { totalBytes: 1, availableBytes: 1 }, binaryInstalled: false, downloadedModelIds: [], downloadError: null, embed: { state: 'idle', modelId: null, endpoint: null } }) }) as any),
    post: (m: any) => posts.push(m),
    openPath: vi.fn(async () => {}),
    saveFile,
    secrets: new SecretStore(join(userDataDir, 'secrets.json'), backend),
  };
  return { deps, posts };
}

// Seeds a single chat with the given messages directly into sessions.json, in the
// shape SessionStore.load expects (nested under its FileMemento key), so tests can
// exercise fork/search/export without needing a live model to populate history via
// handleSend.
function seedChat(userDataDir: string, id: string, title: string, messages: { role: string; content: string }[]) {
  writeFileSync(join(userDataDir, 'sessions.json'), JSON.stringify({
    'fortressCode.chats': {
      activeId: id,
      metas: [{ id, title }],
      messagesById: { [id]: messages },
    },
  }));
}

describe('ChatController', () => {
  it('init posts policy, prefs, key state, dev mode, history, chats', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.init();
    const types = posts.map((p) => p.type);
    for (const t of ['policy', 'prefs', 'openRouterKeySet', 'devMode', 'history', 'chats']) expect(types).toContain(t);
    const prefsPost = posts.find((p) => p.type === 'prefs');
    expect(prefsPost).toEqual({ type: 'prefs', prompts: [], params: {} });
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

  it('savePrompt stores the prompt and re-posts prefs', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'savePrompt', prompt: { id: 'p1', title: 'Greeting', text: 'Say hi' } });
    const prefsPost = posts.at(-1);
    expect(prefsPost).toEqual({ type: 'prefs', prompts: [{ id: 'p1', title: 'Greeting', text: 'Say hi' }], params: {} });
    await c.onMessage({ type: 'deletePrompt', id: 'p1' });
    expect(posts.at(-1)).toEqual({ type: 'prefs', prompts: [], params: {} });
    c.dispose();
  });

  it('setParams stores validated params and re-posts prefs', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'setParams', params: { temperature: 0.5, top_p: 5 } }); // top_p out of range: dropped
    expect(posts.at(-1)).toEqual({ type: 'prefs', prompts: [], params: { temperature: 0.5 } });
    c.dispose();
  });

  it('forkChat produces a Fork:-titled chat with truncated messages', async () => {
    const { deps, posts } = makeDeps();
    seedChat(deps.userDataDir, 'orig', 'Original chat', [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
    const c = new ChatController(deps);
    await c.onMessage({ type: 'forkChat', index: 1 });
    const historyPost = posts.filter((p) => p.type === 'history').at(-1);
    expect(historyPost.messages).toHaveLength(2);
    expect(historyPost.messages.map((m: any) => m.content)).toEqual(['one', 'two']);
    const chatsPost = posts.filter((p) => p.type === 'chats').at(-1);
    const active = chatsPost.metas.find((m: any) => m.id === chatsPost.activeId);
    expect(active.title).toMatch(/^Fork: /);
    c.dispose();
  });

  it('searchChats posts ranked metas', async () => {
    const { deps, posts } = makeDeps();
    writeFileSync(join(deps.userDataDir, 'sessions.json'), JSON.stringify({
      'fortressCode.chats': {
        activeId: 'a',
        metas: [{ id: 'a', title: 'Banking questions' }, { id: 'b', title: 'Other' }],
        messagesById: { a: [{ role: 'user', content: 'banking help' }], b: [{ role: 'user', content: 'unrelated' }] },
      },
    }));
    const c = new ChatController(deps);
    await c.onMessage({ type: 'searchChats', query: 'banking' });
    const results = posts.find((p) => p.type === 'searchResults');
    expect(results.metas.map((m: any) => m.id)).toEqual(['a']);
    c.dispose();
  });

  it('exportChat calls deps.saveFile with markdown content', async () => {
    const { deps } = makeDeps();
    seedChat(deps.userDataDir, 'orig', 'Export me', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    const c = new ChatController(deps);
    await c.onMessage({ type: 'exportChat' });
    expect(deps.saveFile).toHaveBeenCalledTimes(1);
    const [defaultName, content] = (deps.saveFile as any).mock.calls[0];
    expect(defaultName).toMatch(/\.md$/);
    expect(content).toContain('# ');
    c.dispose();
  });
});
