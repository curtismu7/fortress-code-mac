import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatController } from '../src/main/controller';
import { SecretStore, OPENROUTER_KEY_ID, GOOGLE_KEY_ID } from '../src/main/secrets';
import { FileMemento } from '../src/main/fileMemento';

const backend = { encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), isEncryptionAvailable: () => true };

function makeDeps() {
  const posts: any[] = [];
  const userDataDir = mkdtempSync(join(tmpdir(), 'fc-app-'));
  const settings = new FileMemento(join(userDataDir, 'settings.json'));
  settings.update('fortressCode.mcpServers', []);
  settings.update('fortressCode.skillDirectories', ['.fortress/skills']);
  const saveFile = vi.fn(async () => {});
  const deps = {
    userDataDir,
    settings,
    connect: vi.fn(async () => ({ status: async () => ({ state: 'idle', modelId: null, endpoint: null, download: null, crashLog: null, ram: { totalBytes: 1, availableBytes: 1 }, binaryInstalled: false, downloadedModelIds: [], downloadError: null, embed: { state: 'idle', modelId: null, endpoint: null } }) }) as any),
    post: (m: any) => posts.push(m),
    openPath: vi.fn(async () => {}),
    saveFile,
    secrets: new SecretStore(join(userDataDir, 'secrets.json'), backend),
    pickDocuments: vi.fn(async () => []),
    pickImage: vi.fn(async () => null),
    approveEdit: vi.fn(async () => true),
    approveCommand: vi.fn(async () => true),
    writeClipboard: vi.fn(),
    openChatPanel: vi.fn(),
    openSettingsFile: vi.fn(async () => {}),
    showInfo: vi.fn(),
    policyFatal: vi.fn(),
  };
  return { deps, posts };
}

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
  it('init posts full state including skills, personas, mcp', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.init();
    const types = posts.map((p) => p.type);
    for (const t of ['policy', 'prefs', 'personas', 'skills', 'mcpStatus', 'openRouterKeySet', 'googleKeySet', 'devMode', 'history', 'chats', 'memory', 'projectRules']) {
      expect(types).toContain(t);
    }
    const policy = posts.find((p) => p.type === 'policy');
    expect(policy.google?.length).toBeGreaterThan(0);
    c.dispose();
  });

  it('setGoogleKey stores key and posts googleKeySet', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'setGoogleKey', key: 'AIza-test-key' });
    expect(deps.secrets.get(GOOGLE_KEY_ID)).toBe('AIza-test-key');
    expect(posts.at(-1)).toEqual({ type: 'googleKeySet', set: true });
    c.dispose();
  });

  it('setOpenRouterKey triggers a policy fatal (cloud models disabled)', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'setOpenRouterKey', key: 'sk-or-xyz' });
    expect(deps.secrets.get(OPENROUTER_KEY_ID)).toBeUndefined();
    expect(deps.policyFatal).toHaveBeenCalledOnce();
    expect(posts.some((p) => p.type === 'policyFatal')).toBe(true);
    c.dispose();
  });

  it('addModel with a non-US slug triggers policy fatal and quits', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    c.onMessage({ type: 'addModel', slug: 'deepseek/deepseek-chat' });
    expect(deps.policyFatal).toHaveBeenCalledOnce();
    expect(posts.some((p) => p.type === 'policyFatal')).toBe(true);
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

  it('insertCode copies to clipboard; agentToggle updates chat mode', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.onMessage({ type: 'insertCode', code: 'x' });
    expect(deps.writeClipboard).toHaveBeenCalledWith('x');
    await c.onMessage({ type: 'agentToggle', on: true });
    expect(posts.some((p) => p.type === 'chatMode' && p.agentOn === true)).toBe(true);
    c.dispose();
  });

  it('setSkill stores skill on active chat meta', async () => {
    const { deps, posts } = makeDeps();
    const c = new ChatController(deps);
    await c.init();
    await c.onMessage({ type: 'setSkill', id: 'abc123' });
    const chats = posts.filter((p) => p.type === 'chats').at(-1);
    const active = chats.metas.find((m: any) => m.id === chats.activeId);
    expect(active.skillId).toBe('abc123');
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
    await c.onMessage({ type: 'setParams', params: { temperature: 0.5, top_p: 5 } });
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
