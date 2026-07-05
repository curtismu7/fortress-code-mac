import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy, localEntries, explainBlock, type PolicyEntry, type StatusResponse } from '@fortress-code/shared';
import { DaemonClient } from '../../vendor/fortress-code/packages/extension/src/daemon';
import { RagService } from '../../vendor/fortress-code/packages/extension/src/rag/service';
import { Debouncer } from '../../vendor/fortress-code/packages/extension/src/rag/watcher';
import { SessionStore } from '../../vendor/fortress-code/packages/extension/src/sessionStore';
import { splitThink } from '../../vendor/fortress-code/packages/extension/src/reasoning';
import { resolveTarget, type ResolvedTarget } from '../../vendor/fortress-code/packages/extension/src/providers/target';
import { resolveDevTarget } from '../../vendor/fortress-code/packages/extension/src/providers/dev';
import { DEV_PRESETS } from '../../vendor/fortress-code/packages/extension/src/devPresets';
import { streamChat, type Usage } from '../../vendor/fortress-code/packages/extension/src/providers/stream';
import { buildContextPreamble, parseMentions, capContent, type ChatContext, type AttachedFile } from '../../vendor/fortress-code/packages/extension/src/context';
import { FileMemento } from './fileMemento';
import { SecretStore, OPENROUTER_KEY_ID, FIREWORKS_KEY_ID } from './secrets';

const SYSTEM_PROMPT = 'You are Fortress Code, a helpful local coding assistant.';
const DEV_MODE_KEY = 'fortressCode.devMode';

// Local stand-in for vendor agent/tools#resolveInWorkspace — reimplemented here
// so this module never imports vscode-dependent agent tooling.
function resolveInWorkspace(root: string, rel: string): string {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('outside workspace');
  return abs;
}

export interface ControllerDeps {
  userDataDir: string;                         // app.getPath('userData')
  connect: () => Promise<DaemonClient>;        // ensureDaemon(dist/manager/index.js)
  post: (msg: unknown) => void;                // webContents.send bridge
  openPath: (absPath: string) => Promise<void>; // shell.openPath wrapper
  secrets: SecretStore;
}

export class ChatController {
  private root: string | null = null;
  private client: DaemonClient | null = null;
  private rag: RagService | null = null;
  private store: SessionStore;
  private settings: FileMemento;
  private generating: AbortController | null = null;
  private selected: PolicyEntry | null = null;
  private devMode = false;
  private devModel: string | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private watcherStarted = false;
  private ragIndexing = false;

  constructor(private deps: ControllerDeps) {
    this.store = SessionStore.load(new FileMemento(join(deps.userDataDir, 'sessions.json')));
    this.settings = new FileMemento(join(deps.userDataDir, 'settings.json'));
    this.devMode = !!this.settings.get(DEV_MODE_KEY);
  }

  get folder(): string | null { return this.root; }

  private post(msg: unknown): void { this.deps.post(msg); }
  private banner(message: string): void { this.post({ type: 'error', message: (message && message.trim()) ? message : 'Fortress Code error (no details)' }); }

  private async ensureClient(): Promise<DaemonClient> {
    if (!this.client) this.client = await this.deps.connect();
    return this.client;
  }

  private ragService(): RagService | null {
    const root = this.root;
    if (!root) return null;
    if (!this.rag) {
      const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
      const dir = join(this.deps.userDataDir, 'rag', hash);
      this.rag = new RagService(dir, 768, root);
      if (this.rag.hasIndex()) this.startRagWatcher();
    }
    return this.rag;
  }

  async init(): Promise<void> {
    try {
      this.client = await this.deps.connect();
      this.post({ type: 'policy', local: localEntries(), openrouter: loadPolicy().filter((e) => e.provider === 'openrouter') });
      this.post({ type: 'openRouterKeySet', set: !!this.deps.secrets.get(OPENROUTER_KEY_ID) });
      await this.postDev();
      this.post({ type: 'history', messages: this.store.active().messages });
      this.postChats();
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      await this.pushStatus();
      this.post({ type: 'context', chips: [] });
    } catch (e) {
      this.banner(`Could not start the Fortress Code daemon: ${e}`);
    }
  }

  setFolder(root: string): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    this.watcherStarted = false;
    this.root = root;
    this.rag = null;
    const rag = this.ragService();
    if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: this.ragIndexing });
  }

  setDevMode(on: boolean): void {
    this.devMode = on;
    if (!on) this.devModel = null;
    this.settings.update(DEV_MODE_KEY, on);
    void this.postDev();
  }

  private async postDev(): Promise<void> {
    this.post({ type: 'devMode', on: this.devMode, presets: DEV_PRESETS, fireworksKeySet: !!this.deps.secrets.get(FIREWORKS_KEY_ID) });
  }

  private postChats(): void {
    this.post({ type: 'chats', metas: this.store.metas(), activeId: this.store.activeId });
  }

  private postContextWindow(): void {
    let tokens = 8192;
    if (this.selected?.provider === 'openrouter') tokens = this.selected.openrouter?.contextLength ?? 8192;
    this.post({ type: 'contextWindow', tokens });
  }

  private async regenerate(): Promise<void> {
    const msgs = this.store.active().messages;
    while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return;
    const text = last.content;
    msgs.pop(); // handleSend re-adds it
    this.store.save();
    this.post({ type: 'history', messages: msgs });
    await this.handleSend(text);
  }

  private async collectContext(userText: string): Promise<ChatContext> {
    const file: ChatContext['file'] = null;
    const selection: ChatContext['selection'] = null;
    const root = this.root;
    const mentions: AttachedFile[] = [];
    if (root) for (const mrel of parseMentions(userText)) {
      if (mrel === 'codebase') continue;
      try {
        const abs = resolveInWorkspace(root, mrel);
        const cap = capContent(readFileSync(abs, 'utf8'));
        mentions.push({ id: 'mention:' + mrel, relPath: mrel, language: mrel.split('.').pop() ?? '', content: cap.content, truncated: cap.truncated, diagnostics: [] });
      } catch { /* skip unreadable/escaping mention */ }
    }
    let codebase: ChatContext['codebase'] = null;
    const rag = this.ragService();
    if (rag && parseMentions(userText).includes('codebase') && this.client) {
      try { codebase = await rag.retrieveHits(this.client, userText); }
      catch (e) { this.banner(`@codebase retrieval failed: ${e instanceof Error ? e.message : e}`); }
    }
    return { file, selection, mentions, codebase };
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) return;
    try {
      const status: StatusResponse = await this.client.status();
      this.post({ type: 'state', status, selectedId: this.selected?.id ?? null });
      const rag = this.ragService();
      if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: this.ragIndexing });
    } catch {
      this.client = null; // daemon idle-exited; next action re-spawns
    }
  }

  private startRagWatcher(): void {
    if (this.watcherStarted) return;
    const rag = this.ragService();
    if (!rag || !this.root) return;
    this.watcherStarted = true;
    const debouncer = new Debouncer(1000, async () => {
      if (!this.client) return;
      if (this.ragIndexing) return;
      this.ragIndexing = true;
      try {
        await rag.index(this.client, (p) => this.post({ type: 'ragProgress', progress: p }));
        this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
      } catch { /* transient; next save retries */ }
      finally { this.ragIndexing = false; }
    });
    try {
      this.watcher = watch(this.root, { recursive: true }, (_e, filename) => { if (filename) debouncer.add(filename); });
    } catch { this.watcherStarted = false; }
  }

  async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'send': return await this.handleSend(String(m.text));
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': this.generating?.abort(); this.store.newChat(); this.post({ type: 'history', messages: [] }); this.postChats(); return;
        case 'switchChat': this.generating?.abort(); this.store.switchTo(String(m.id)); this.post({ type: 'history', messages: this.store.active().messages }); this.postChats(); return;
        case 'regenerate': return await this.regenerate();
        case 'editLoad': {
          const msgs = this.store.active().messages;
          const um = msgs[Number(m.index)];
          if (um && um.role === 'user') { msgs.length = Number(m.index); this.store.save(); this.post({ type: 'history', messages: msgs }); this.post({ type: 'restoreInput', text: um.content }); }
          return;
        }
        case 'agentToggle': return; // agent mode not available in the Mac app
        case 'selectModel': return await this.selectModel(String(m.id));
        case 'addModel': return this.handleAddModel(String(m.slug));
        case 'setOpenRouterKey': this.deps.secrets.set(OPENROUTER_KEY_ID, String(m.key)); this.post({ type: 'openRouterKeySet', set: true }); return;
        case 'setFireworksKey': this.deps.secrets.set(FIREWORKS_KEY_ID, String(m.key)); await this.postDev(); return;
        case 'selectDevModel': this.devModel = String(m.slug) || null; this.selected = null; this.postContextWindow(); return;
        case 'downloadModel': await (await this.ensureClient()).download(String(m.catalogId)); return;
        case 'indexWorkspace': {
          if (this.ragIndexing) return;
          this.ragIndexing = true;
          let rag: RagService | null = null;
          try {
            rag = this.ragService();
            if (!rag) { this.banner('Open a folder to index a codebase.'); return; }
            const client = await this.ensureClient();
            this.post({ type: 'ragProgress', progress: { filesDone: 0, filesTotal: 0, chunksDone: 0, capped: false } });
            await rag.index(client, (p) => this.post({ type: 'ragProgress', progress: p }));
            this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
            this.startRagWatcher();
          } catch (e) {
            this.banner(`Indexing failed: ${e instanceof Error ? e.message : e}`);
            if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
          } finally {
            this.ragIndexing = false;
          }
          return;
        }
        case 'installBinary': await (await this.ensureClient()).installBinary(); return;
        case 'killForeign': await (await this.ensureClient()).foreignKill(m.pids); return;
        case 'excludeContext': return; // no chips in the Mac app; nothing to exclude
        case 'insertCode': this.banner('Not available in the Mac app.'); return;
        case 'applyCode': this.banner('Not available in the Mac app.'); return;
        case 'openSource': {
          if (!this.root) { this.banner('Open a folder to jump to a source.'); return; }
          try {
            const abs = resolveInWorkspace(this.root, String(m.file));
            await this.deps.openPath(abs);
          } catch (e) {
            this.banner(`Could not open ${String(m.file)}: ${e instanceof Error ? e.message : e}`);
          }
          return;
        }
      }
    } catch (e) {
      this.banner(String(e));
    }
  }

  private async selectModel(id: string): Promise<void> {
    const entry = loadPolicy().find((e) => e.id === id);
    if (!entry) return;
    this.selected = entry;
    this.devModel = null; // picking a governed model takes over from any dev-model routing
    if (entry.provider === 'local') {
      if (!this.client) this.client = await this.deps.connect();
      try {
        const r = await this.client.start(entry.local!.catalogId);
        if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId: id });
      } catch (e) {
        const msg = String(e);
        if (msg.includes('428')) this.banner('This model needs to be downloaded first — click it to download.');
        else this.banner(msg);
      }
    }
    await this.pushStatus();
    this.postContextWindow();
  }

  private handleAddModel(slug: string): void {
    const reason = explainBlock(slug);
    if (reason) { this.post({ type: 'addBlocked', slug, reason }); return; }
    // Approved slug: it is already in the registry; surface it as selectable.
    this.post({ type: 'addAccepted', slug });
  }

  private async targetDeps() {
    const status = this.client ? await this.client.status().catch(() => null) : null;
    return {
      localEndpoint: status?.endpoint ?? undefined,
      openRouterKey: this.deps.secrets.get(OPENROUTER_KEY_ID),
    };
  }

  private async currentTarget(): Promise<ResolvedTarget> {
    if (this.devMode && this.devModel) {
      const key = this.deps.secrets.get(FIREWORKS_KEY_ID);
      return resolveDevTarget(this.devModel, key ?? '');
    }
    if (this.selected) {
      if (!this.client) this.client = await this.deps.connect();
      return resolveTarget(this.selected, await this.targetDeps());
    }
    throw new Error('Pick a model first.');
  }

  private async handleSend(text: string): Promise<void> {
    if (this.generating) { this.banner('Still generating — press Stop first.'); this.post({ type: 'restoreInput', text }); return; }
    let target: ResolvedTarget;
    try {
      target = await this.currentTarget();
    } catch (e) {
      this.banner(String(e instanceof Error ? e.message : e));
      this.post({ type: 'restoreInput', text });
      return;
    }
    const session = this.store.active();
    const ctx = await this.collectContext(text);
    const preamble = buildContextPreamble(ctx);
    const sys = SYSTEM_PROMPT + (preamble ? '\n\n---\n' + preamble : '');
    const preTurnLen = session.messages.length;
    session.addUser(text);
    this.post({ type: 'history', messages: session.messages });
    this.generating = new AbortController();
    let usage: Usage | null = null;
    try {
      const r = await streamChat(target, session.toRequestMessages(sys),
        (t) => this.post({ type: 'token', text: t }), this.generating.signal,
        (t) => this.post({ type: 'reasoning', text: t }));
      session.addAssistant(splitThink(r.content).content || '(no reply)');
      if (ctx.codebase && ctx.codebase.length) {
        const last = session.messages[session.messages.length - 1];
        last.sources = ctx.codebase.map(({ file, startLine, endLine }) => ({ file, startLine, endLine }));
      }
      this.post({ type: 'reasoningDone' });
      usage = r.usage;
      this.store.touchTitle();
      this.store.save();
      this.post({ type: 'history', messages: session.messages });
      this.postChats();
      if (usage) this.post({ type: 'usage', usage });
    } catch (e) {
      session.messages.length = preTurnLen; // error hygiene: remove user msg + any tool exchange from the failed turn
      this.store.save();
      this.post({ type: 'history', messages: session.messages });
      this.post({ type: 'restoreInput', text });
      this.banner(String(e instanceof Error ? e.message : e));
    } finally {
      this.generating = null;
    }
  }

  dispose(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  }
}
