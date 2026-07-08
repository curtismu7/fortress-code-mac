import { readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy, visibleLocalEntries, hiddenLocalEntries, googleEntries, explainBlock, formatPolicyFatal, type PolicyEntry, type StatusResponse } from '@fortress-chat/shared';
import { DaemonClient } from '../../vendor/fortress-code/packages/extension/src/daemon';
import { RagService } from '../../vendor/fortress-code/packages/extension/src/rag/service';
import { Debouncer } from '../../vendor/fortress-code/packages/extension/src/rag/watcher';
import { SessionStore } from '../../vendor/fortress-code/packages/extension/src/sessionStore';
import { Session } from '../../vendor/fortress-code/packages/extension/src/chat/session';
import { splitThink } from '../../vendor/fortress-code/packages/extension/src/reasoning';
import { resolveTarget, type ResolvedTarget } from '../../vendor/fortress-code/packages/extension/src/providers/target';
import { resolveDevTarget } from '../../vendor/fortress-code/packages/extension/src/providers/dev';
import { DEV_PRESETS } from '../../vendor/fortress-code/packages/extension/src/devPresets';
import { streamChat, type Usage } from '../../vendor/fortress-code/packages/extension/src/providers/stream';
import { runAgentTurn } from '../../vendor/fortress-code/packages/extension/src/agent/loop';
import { buildContextPreamble, parseMentions, capContent, type ChatContext, type AttachedFile } from '../../vendor/fortress-code/packages/extension/src/context';
import { Prefs } from '../../vendor/fortress-code/packages/extension/src/prefs';
import { searchChats } from '../../vendor/fortress-code/packages/extension/src/chatSearch';
import { exportMarkdown } from '../../vendor/fortress-code/packages/extension/src/exportChat';
import { MemoryStore } from '../../vendor/fortress-code/packages/extension/src/memory';
import { DocsService } from '../../vendor/fortress-code/packages/extension/src/docsService';
import { McpClient, parseMcpConfigs, type McpServerConfig } from '../../vendor/fortress-code/packages/extension/src/mcpClient';
import { webSearch } from '../../vendor/fortress-code/packages/extension/src/webSearch';
import { speakText } from '../../vendor/fortress-code/packages/extension/src/voice';
import { loadProjectRules, defaultRulesRel } from '../../vendor/fortress-code/packages/extension/src/projectRules';
import { AgentCheckpoint } from '../../vendor/fortress-code/packages/extension/src/agentCheckpoint';
import { mentionCandidates } from '../../vendor/fortress-code/packages/extension/src/mentionFiles';
import { discoverSkills, DEFAULT_SKILL_DIRS, type Skill } from '../../vendor/fortress-code/packages/extension/src/skills';
import { FileMemento } from './fileMemento';
import { SecretStore, OPENROUTER_KEY_ID, FIREWORKS_KEY_ID, GOOGLE_KEY_ID } from './secrets';
import { validateGoogleApiKey } from './validateGoogleKey';
import { executeMacTool, resolveInWorkspace } from './macTools';

const SYSTEM_PROMPT = 'You are Fortress Code, a helpful local coding assistant.';
const DEV_MODE_KEY = 'fortressCode.devMode';
const MCP_KEY = 'fortressCode.mcpServers';
const SKILL_DIRS_KEY = 'fortressCode.skillDirectories';

const MODE_PROMPTS: Record<string, string> = {
  plan: 'You are in plan mode. Outline a clear step-by-step plan before editing files. Discuss tradeoffs and wait for confirmation before applying changes unless the user asked you to implement immediately.',
  debug: 'You are in debug mode. Focus on reproducing the issue, tracing root cause, and proposing minimal targeted fixes.',
};

type ChatMode = 'ask' | 'agent' | 'plan' | 'debug' | 'multitask';

export interface ControllerDeps {
  userDataDir: string;
  settings: FileMemento;
  connect: () => Promise<DaemonClient>;
  post: (msg: unknown) => void;
  openPath: (absPath: string) => Promise<void>;
  saveFile: (defaultName: string, content: string) => Promise<void>;
  secrets: SecretStore;
  pickDocuments: () => Promise<string[]>;
  pickImage: () => Promise<{ mime: string; base64: string; name: string } | null>;
  approveEdit: (rel: string, isNew: boolean) => Promise<boolean>;
  approveCommand: (command: string) => Promise<boolean>;
  writeClipboard: (text: string) => void;
  openChatPanel?: () => void;
  openSettingsFile: () => Promise<void>;
  showInfo: (message: string) => void;
  policyFatal: (message: string) => void;
}

export class ChatController {
  private root: string | null = null;
  private client: DaemonClient | null = null;
  private rag: RagService | null = null;
  private docs: DocsService | null = null;
  private mcpClients: McpClient[] = [];
  private mcpTools: object[] = [];
  private pendingImages: { mime: string; base64: string; name: string }[] = [];
  private compareModelId: string | null = null;
  private store: SessionStore;
  private prefs: Prefs;
  private generating: AbortController | null = null;
  private agentMode = false;
  private chatMode: ChatMode = 'ask';
  private selected: PolicyEntry | null = null;
  private devMode = false;
  private devModel: string | null = null;
  private excluded = new Set<string>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private ragWatcher: FSWatcher | null = null;
  private skillsWatcher: FSWatcher | null = null;
  private ragWatcherStarted = false;
  private skillsWatcherStarted = false;
  private ragIndexing = false;
  private lastCheckpoint: AgentCheckpoint | null = null;
  private skills: Skill[] = [];
  private policyStopped = false;

  constructor(private deps: ControllerDeps) {
    this.store = SessionStore.load(new FileMemento(join(deps.userDataDir, 'sessions.json')));
    this.prefs = new Prefs(new FileMemento(join(deps.userDataDir, 'prefs.json')));
    this.devMode = false;
    deps.settings.update(DEV_MODE_KEY, false);
  }

  get folder(): string | null { return this.root; }

  private post(msg: unknown): void { this.deps.post(msg); }
  private banner(message: string): void { this.post({ type: 'error', message: (message && message.trim()) ? message : 'Fortress Code error (no details)' }); }
  private hint(message: string): void { this.post({ type: 'hint', message: (message && message.trim()) ? message : '' }); }
  private postGenerating(active: boolean): void { this.post({ type: 'generating', active }); }

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

  private docsService(): DocsService {
    if (!this.docs) this.docs = new DocsService(join(this.deps.userDataDir, 'docs-index'));
    return this.docs;
  }

  private memoryPath(): string { return join(this.deps.userDataDir, 'memory.json'); }
  private memoryData(): ReturnType<MemoryStore['load']> { return new MemoryStore(this.memoryPath()).load(); }

  private mcpConfigs(): McpServerConfig[] {
    return parseMcpConfigs(this.deps.settings.get(MCP_KEY));
  }

  private skillDirectories(): string[] {
    const raw = this.deps.settings.get(SKILL_DIRS_KEY);
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [...DEFAULT_SKILL_DIRS];
  }

  private systemPromptForChat(): string {
    const meta = this.store.metas().find((m) => m.id === this.store.activeId);
    const persona = meta?.personaId ? this.prefs.personas().find((p) => p.id === meta.personaId) : undefined;
    const skill = meta?.skillId ? this.skills.find((s) => s.id === meta.skillId) : undefined;
    const mem = MemoryStore.preamble(this.memoryData());
    const rules = loadProjectRules(this.root ?? undefined).text;
    let base = persona?.systemPrompt?.trim() || SYSTEM_PROMPT;
    if (skill?.body.trim()) base = `${base}\n\n[skill: ${skill.name}]\n${skill.body.trim()}`;
    const modeHint = MODE_PROMPTS[this.chatMode] ?? '';
    return [base, mem, rules, modeHint].filter(Boolean).join('\n\n');
  }

  private refreshSkills(): void {
    this.skills = discoverSkills(this.skillDirectories(), this.root ?? undefined);
    this.post({ type: 'skills', skills: this.skills });
  }

  private postMcpStatus(): void {
    this.post({
      type: 'mcpStatus',
      servers: this.mcpClients.map((c) => ({
        name: c.serverName(), connected: c.isConnected(), tools: c.toolCount(), error: c.error(),
      })),
    });
  }

  private postChatMode(): void {
    const agentCapable = this.devMode && this.devModel ? true : !!this.selected?.agentCapable;
    this.post({ type: 'chatMode', mode: this.chatMode, agentOn: this.agentMode, compareId: this.compareModelId, agentCapable });
  }

  private postAgentUndo(): void {
    this.post({ type: 'agentUndo', available: !!(this.lastCheckpoint && this.lastCheckpoint.hasChanges()) });
  }

  private toolExtras(checkpoint?: AgentCheckpoint) {
    const memPath = this.memoryPath();
    return {
      webSearch: (q: string) => webSearch(q),
      remember: (fact: string) => {
        const store = new MemoryStore(memPath);
        const data = store.load();
        data.enabled = true;
        if (fact.trim() && !data.facts.includes(fact.trim())) data.facts.push(fact.trim());
        store.save(data);
        this.post({ type: 'memory', data });
        return 'saved to local memory';
      },
      mcpCall: async (name: string, args: Record<string, unknown>) => {
        for (const c of this.mcpClients) {
          try { return await c.callTool(name, args); } catch { continue; }
        }
        return 'mcp tool not found';
      },
      onFileTouch: checkpoint ? (rel: string, abs: string) => checkpoint.capture(rel, abs) : undefined,
      onFileRevertCapture: checkpoint ? (rel: string) => checkpoint.revert(rel) : undefined,
    };
  }

  private async initMcp(): Promise<void> {
    const cfgs = this.mcpConfigs();
    for (const c of this.mcpClients) c.dispose();
    this.mcpClients = cfgs.map((cfg) => new McpClient(cfg));
    this.mcpTools = [];
    for (const client of this.mcpClients) {
      try { await client.connect(); this.mcpTools.push(...client.openAiSchemas()); } catch { /* stored on client */ }
    }
    this.postMcpStatus();
  }

  private async pushFullState(): Promise<void> {
    this.post({ type: 'policy', local: visibleLocalEntries(), hidden: hiddenLocalEntries(), google: googleEntries(), openrouter: [] });
    this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() });
    this.post({ type: 'personas', personas: this.prefs.personas() });
    this.post({ type: 'skills', skills: this.skills });
    this.post({ type: 'workspace', open: !!this.root });
    this.post({ type: 'projectRules', path: loadProjectRules(this.root ?? undefined).path ?? defaultRulesRel(this.root ?? undefined) });
    this.post({ type: 'memory', data: this.memoryData() });
    this.post({ type: 'folders', folders: this.store.listFolders() });
    this.post({ type: 'docsStatus', stats: this.docsService().stats() });
    this.postMcpStatus();
    this.post({ type: 'openRouterKeySet', set: !!this.deps.secrets.get(OPENROUTER_KEY_ID) });
    const googleKeySaved = !!this.deps.secrets.get(GOOGLE_KEY_ID);
    this.post({
      type: 'googleKeySet',
      set: googleKeySaved,
      message: googleKeySaved ? 'Google API key is saved.' : undefined,
    });
    await this.postDev();
    this.post({ type: 'history', messages: this.store.active().messages });
    this.postChats();
    await this.pushStatus();
    this.postAgentUndo();
    this.postChatMode();
    this.post({ type: 'context', chips: [] });
    this.post({ type: 'generating', active: !!this.generating });
  }

  async init(): Promise<void> {
    try {
      this.sanitizeLocalUsOnly();
      try {
        this.client = await this.deps.connect();
      } catch (e) {
        if (!this.deps.secrets.get(GOOGLE_KEY_ID)) {
          this.banner(`Could not start the Fortress Code daemon: ${e}`);
          return;
        }
      }
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      this.refreshSkills();
      this.startSkillsWatcher();
      await this.initMcp();
      await this.pushFullState();
    } catch (e) {
      this.banner(`Could not start the Fortress Code daemon: ${e}`);
    }
  }

  setFolder(root: string): void {
    if (this.ragWatcher) { this.ragWatcher.close(); this.ragWatcher = null; }
    if (this.skillsWatcher) { this.skillsWatcher.close(); this.skillsWatcher = null; }
    this.ragWatcherStarted = false;
    this.skillsWatcherStarted = false;
    this.root = root;
    this.rag = null;
    this.post({ type: 'workspace', open: true });
    this.refreshSkills();
    const rag = this.ragService();
    if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: this.ragIndexing });
    this.post({ type: 'projectRules', path: loadProjectRules(root).path ?? defaultRulesRel(root) });
    this.startSkillsWatcher();
  }

  setDevMode(on: boolean): void {
    if (on) {
      this.stopForPolicyViolation('Developer mode and cloud models are not allowed.');
      return;
    }
    this.devMode = false;
    this.devModel = null;
    this.deps.settings.update(DEV_MODE_KEY, false);
    void this.postDev();
    this.postChatMode();
  }

  /** Stop the app after a local-US-only policy violation. */
  private stopForPolicyViolation(reason: string, slug?: string): void {
    if (this.policyStopped) return;
    this.policyStopped = true;
    const message = formatPolicyFatal(reason, slug);
    this.post({ type: 'policyFatal', message });
    this.deps.policyFatal(message);
  }

  /** Clear cloud/dev routing left over from before local-US-only enforcement. */
  private sanitizeLocalUsOnly(): void {
    if (this.devMode || this.devModel) {
      this.devMode = false;
      this.devModel = null;
      this.deps.settings.update(DEV_MODE_KEY, false);
    }
    if (this.selected?.provider !== 'local' && this.selected?.provider !== 'google') this.selected = null;
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
    else if (this.selected?.provider === 'google') tokens = this.selected.google?.contextLength ?? 8192;
    this.post({ type: 'contextWindow', tokens });
  }

  private async regenerate(): Promise<void> {
    const msgs = this.store.active().messages;
    while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return;
    const text = last.content;
    msgs.pop();
    this.store.save();
    this.post({ type: 'history', messages: msgs });
    await this.handleSend(text);
  }

  private async collectContext(userText: string): Promise<ChatContext> {
    const root = this.root;
    const mentions: AttachedFile[] = [];
    if (root) for (const mrel of parseMentions(userText)) {
      if (mrel === 'codebase' || mrel === 'docs') continue;
      const mid = 'mention:' + mrel;
      if (this.excluded.has(mid)) continue;
      try {
        const abs = resolveInWorkspace(root, mrel);
        const cap = capContent(readFileSync(abs, 'utf8'));
        mentions.push({ id: mid, relPath: mrel, language: mrel.split('.').pop() ?? '', content: cap.content, truncated: cap.truncated, diagnostics: [] });
      } catch { /* skip */ }
    }
    let codebase: ChatContext['codebase'] = null;
    const rag = this.ragService();
    if (rag && parseMentions(userText).includes('codebase') && this.client) {
      try { codebase = await rag.retrieveHits(this.client, userText); }
      catch (e) { this.banner(`@codebase retrieval failed: ${e instanceof Error ? e.message : e}`); }
    }
    let docs: ChatContext['docs'] = null;
    if (parseMentions(userText).includes('docs')) {
      if (!this.docsService().hasIndex()) {
        this.banner('No documents indexed yet — use Settings → Documents → Add documents.');
      } else if (this.client) {
        try { docs = await this.docsService().retrieveHits(this.client, userText); }
        catch (e) { this.banner(`@docs retrieval failed: ${e instanceof Error ? e.message : e}`); }
      }
    }
    const images = this.pendingImages.length ? [...this.pendingImages] : undefined;
    this.pendingImages = [];
    return { file: null, selection: null, mentions, codebase, docs, images };
  }

  private cloudFallbackStatus(): StatusResponse {
    return {
      state: 'idle',
      modelId: null,
      endpoint: null,
      download: null,
      crashLog: null,
      ram: { totalBytes: 0, availableBytes: 0 },
      binaryInstalled: false,
      downloadedModelIds: [],
      downloadError: null,
      embed: { state: 'idle', modelId: null, endpoint: null },
    };
  }

  /** Unload the local chat llama-server when switching to cloud routing. */
  private async unloadLocalModel(): Promise<void> {
    if (!this.client) return;
    try {
      const status = await this.client.status();
      if (status.state === 'ready' || status.state === 'loading-model' || status.state === 'starting') {
        await this.client.stop();
      }
    } catch { /* daemon gone */ }
  }

  /** Reload the selected local chat model after a temporary embed swap. */
  private async restartLocalIfSelected(): Promise<void> {
    if (this.selected?.provider !== 'local' || !this.client) return;
    try {
      const r = await this.client.start(this.selected.local!.catalogId);
      if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId: this.selected.id });
    } catch (e) {
      this.banner(String(e));
    }
    await this.pushStatus();
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) {
      this.post({ type: 'state', status: this.cloudFallbackStatus(), selectedId: this.selected?.id ?? null });
      return;
    }
    try {
      const status: StatusResponse = await this.client.status();
      this.post({ type: 'state', status, selectedId: this.selected?.id ?? null });
      const rag = this.ragService();
      if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: this.ragIndexing });
    } catch {
      this.client = null;
    }
  }

  private startRagWatcher(): void {
    if (this.ragWatcherStarted || !this.root) return;
    const rag = this.ragService();
    if (!rag) return;
    this.ragWatcherStarted = true;
    const debouncer = new Debouncer(1000, async () => {
      if (!this.client || this.ragIndexing) return;
      this.ragIndexing = true;
      try {
        await rag.index(this.client, (p) => this.post({ type: 'ragProgress', progress: p }));
        this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
      } catch { /* retry on next save */ }
      finally { this.ragIndexing = false; }
    });
    try {
      this.ragWatcher = watch(this.root, { recursive: true }, (_e, filename) => { if (filename) debouncer.add(filename); });
    } catch { this.ragWatcherStarted = false; }
  }

  private startSkillsWatcher(): void {
    if (this.skillsWatcherStarted || !this.root) return;
    const dir = join(this.root, '.fortress', 'skills');
    this.skillsWatcherStarted = true;
    const debouncer = new Debouncer(500, () => this.refreshSkills());
    try {
      this.skillsWatcher = watch(dir, { recursive: true }, () => debouncer.add(dir));
    } catch { this.skillsWatcherStarted = false; }
  }

  async onMessage(m: any): Promise<void> {
    if (this.policyStopped) return;
    try {
      switch (m.type) {
        case 'openChatInEditor':
          if (this.deps.openChatPanel) this.deps.openChatPanel();
          else this.banner('Could not open a second chat window.');
          return;
        case 'send': return await this.handleSend(String(m.text));
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': {
          this.generating?.abort();
          const agent = !!m.agent;
          if (agent && !this.root) {
            this.hint('Please use File → Open Folder to use New agent.');
            return;
          }
          this.store.newChat(agent);
          this.agentMode = agent; this.chatMode = agent ? 'agent' : 'ask';
          this.post({ type: 'history', messages: [] });
          this.postChatMode(); this.postChats();
          return;
        }
        case 'switchChat': {
          this.generating?.abort();
          this.store.switchTo(String(m.id));
          // Restore per-chat agent mode so the sidebar badge and composer reflect the chat's saved state.
          const meta = this.store.metas().find((c) => c.id === this.store.activeId);
          this.agentMode = !!meta?.agentMode; this.chatMode = this.agentMode ? 'agent' : 'ask';
          this.post({ type: 'history', messages: this.store.active().messages });
          this.postChatMode(); this.postChats();
          return;
        }
        case 'deleteChat': {
          this.generating?.abort();
          this.store.deleteChat(String(m.id));
          const meta = this.store.metas().find((c) => c.id === this.store.activeId);
          this.agentMode = !!meta?.agentMode; this.chatMode = this.agentMode ? 'agent' : 'ask';
          this.post({ type: 'history', messages: this.store.active().messages });
          this.postChatMode(); this.postChats();
          return;
        }
        case 'renameChat': {
          this.store.renameChat(String(m.id), String(m.title ?? ''));
          this.postChats();
          return;
        }
        case 'regenerate': return await this.regenerate();
        case 'editLoad': {
          const msgs = this.store.active().messages;
          const um = msgs[Number(m.index)];
          if (um && um.role === 'user') { msgs.length = Number(m.index); this.store.save(); this.post({ type: 'history', messages: msgs }); this.post({ type: 'restoreInput', text: um.content }); }
          return;
        }
        case 'agentToggle': this.agentMode = !!m.on; this.chatMode = this.agentMode ? 'agent' : 'ask'; this.store.setAgentMode(this.store.activeId, this.agentMode); this.postChatMode(); return;
        case 'setChatMode': {
          const mode = String(m.mode) as ChatMode;
          if (!['ask', 'agent', 'plan', 'debug', 'multitask'].includes(mode)) return;
          const agentCapable = this.devMode && this.devModel ? true : !!this.selected?.agentCapable;
          if ((mode === 'plan' || mode === 'debug' || mode === 'agent') && !agentCapable) {
            this.banner('This model does not support agent modes. Pick an agent-capable model.');
            return;
          }
          this.chatMode = mode;
          this.agentMode = mode === 'agent' || mode === 'plan' || mode === 'debug';
          this.store.setAgentMode(this.store.activeId, this.agentMode);
          if (mode === 'multitask' && !this.compareModelId) this.post({ type: 'openActionSub', sub: 'multitask' });
          this.postChatMode();
          return;
        }
        case 'openMcpSettings':
        case 'openSkillSettings':
          await this.deps.openSettingsFile();
          return;
        case 'reloadMcp': await this.initMcp(); return;
        case 'reloadSkills': this.refreshSkills(); return;
        case 'selectModel': return await this.selectModel(String(m.id));
        case 'addModel': return this.handleAddModel(String(m.slug));
        case 'setOpenRouterKey':
          return this.stopForPolicyViolation('Cloud models are not allowed.');
        case 'setGoogleKey': {
          const key = String(m.key ?? '').trim();
          const result = await validateGoogleApiKey(key);
          if (!result.ok) {
            const saved = !!this.deps.secrets.get(GOOGLE_KEY_ID);
            this.post({
              type: 'googleKeySet',
              set: saved,
              message: saved ? 'Google API key is saved.' : undefined,
              error: result.message,
            });
            return;
          }
          this.deps.secrets.set(GOOGLE_KEY_ID, key);
          if (!this.selected) {
            const gemini = googleEntries()[0];
            if (gemini) await this.selectModel(gemini.id);
          }
          this.post({ type: 'googleKeySet', set: true, message: 'Google API key saved and verified.' });
          await this.pushFullState();
          return;
        }
        case 'setFireworksKey':
          return this.stopForPolicyViolation('Developer mode and cloud models are not allowed.');
        case 'selectDevModel':
          return this.stopForPolicyViolation('Developer mode and cloud models are not allowed.', String(m.slug || ''));
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
          } finally { this.ragIndexing = false; }
          return;
        }
        case 'installBinary': await (await this.ensureClient()).installBinary(); return;
        case 'killForeign': await (await this.ensureClient()).foreignKill(m.pids); return;
        case 'excludeContext': this.excluded.add(String(m.id)); return;
        case 'insertCode': this.deps.writeClipboard(String(m.code)); this.deps.showInfo('Code copied to clipboard.'); return;
        case 'applyCode': this.deps.writeClipboard(String(m.code)); this.deps.showInfo('Code copied to clipboard — paste into your editor to apply.'); return;
        case 'openSource': {
          if (!this.root) { this.banner('Open a folder to jump to a source.'); return; }
          try { await this.deps.openPath(resolveInWorkspace(this.root, String(m.file))); }
          catch (e) { this.banner(`Could not open ${String(m.file)}: ${e instanceof Error ? e.message : e}`); }
          return;
        }
        case 'savePrompt': this.prefs.savePrompt(m.prompt); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'deletePrompt': this.prefs.deletePrompt(String(m.id)); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'setParams': this.prefs.setParams(m.params ?? {}); this.post({ type: 'prefs', prompts: this.prefs.prompts(), params: this.prefs.params() }); return;
        case 'forkChat': this.generating?.abort(); this.store.fork(Number(m.index)); this.post({ type: 'history', messages: this.store.active().messages }); this.postChats(); return;
        case 'searchChats': this.post({ type: 'searchResults', metas: searchChats(String(m.query ?? ''), this.store.metas(), this.store.messagesById(), m.folder ? String(m.folder) : undefined) }); return;
        case 'setFolder': this.store.setFolder(this.store.activeId, m.folder ? String(m.folder) : undefined); this.post({ type: 'folders', folders: this.store.listFolders() }); this.postChats(); return;
        case 'setMemory': {
          const store = new MemoryStore(this.memoryPath());
          store.save({ enabled: !!m.enabled, facts: Array.isArray(m.facts) ? m.facts.map(String) : store.load().facts });
          this.post({ type: 'memory', data: store.load() }); return;
        }
        case 'rememberFact': {
          const fact = String(m.text ?? '').trim();
          if (!fact) return;
          const store = new MemoryStore(this.memoryPath());
          const data = store.load();
          data.enabled = true;
          if (!data.facts.includes(fact)) data.facts.push(fact);
          store.save(data);
          this.post({ type: 'memory', data });
          this.deps.showInfo('Saved to local memory.');
          return;
        }
        case 'indexDocs': {
          const picks = await this.deps.pickDocuments();
          if (!picks.length) return;
          const client = await this.ensureClient();
          const result = await this.docsService().indexFiles(
            client,
            picks,
            (done, total, file) => this.post({ type: 'docsProgress', done, total, file: file ? file.split('/').pop() : undefined }),
          );
          if (result.errors.length) {
            const first = result.errors[0]!;
            this.banner(`Could not index ${result.errors.length} file(s): ${first.reason}`);
          }
          await this.restartLocalIfSelected();
          this.post({ type: 'docsStatus', stats: this.docsService().stats(), lastIndex: result }); return;
        }
        case 'attachImage': {
          const img = await this.deps.pickImage();
          if (!img) return;
          this.pendingImages.push(img);
          this.post({ type: 'attachedImages', count: this.pendingImages.length }); return;
        }
        case 'speakLast': {
          const msgs = this.store.active().messages;
          const last = [...msgs].reverse().find((x) => x.role === 'assistant');
          if (last) void speakText(last.content).catch((e) => this.banner(String(e))); return;
        }
        case 'setCompareModel': this.compareModelId = m.id ? String(m.id) : null; if (this.compareModelId) this.chatMode = 'multitask'; this.postChatMode(); return;
        case 'showArtifact': this.post({ type: 'artifact', html: String(m.html ?? '') }); return;
        case 'exportChat': {
          const title = this.store.metas().find((x) => x.id === this.store.activeId)?.title ?? 'Chat';
          const md = exportMarkdown(title, this.store.active().messages, new Date());
          await this.deps.saveFile(title.replace(/[^\w-]+/g, '-') + '.md', md);
          return;
        }
        case 'listMentionFiles':
          this.post({ type: 'mentionFiles', items: mentionCandidates(this.root ?? undefined, String(m.query ?? '')) });
          return;
        case 'undoAgentRun': {
          if (!this.root || !this.lastCheckpoint?.hasChanges()) { this.banner('Nothing to undo from the last agent run.'); return; }
          const restored = this.lastCheckpoint.restore(this.root);
          this.lastCheckpoint = null;
          this.postAgentUndo();
          this.deps.showInfo(restored.length ? `Restored ${restored.length} file(s) from before the last agent run.` : 'Agent run undone.');
          return;
        }
        case 'openRulesFile': {
          if (!this.root) { this.banner('Open a folder to edit project rules.'); return; }
          const rel = defaultRulesRel(this.root);
          const abs = join(this.root, rel);
          try { readFileSync(abs); } catch {
            writeFileSync(abs, '# Project rules\n\nAdd instructions Fortress Code should follow in this repo.\n', 'utf8');
          }
          await this.deps.openPath(abs);
          return;
        }
        case 'savePersona': this.prefs.savePersona(m.persona); this.post({ type: 'personas', personas: this.prefs.personas() }); return;
        case 'deletePersona': this.prefs.deletePersona(String(m.id)); this.post({ type: 'personas', personas: this.prefs.personas() }); return;
        case 'setPersona': this.store.setPersona(this.store.activeId, m.id ? String(m.id) : undefined); this.postChats(); return;
        case 'setSkill': this.store.setSkill(this.store.activeId, m.id ? String(m.id) : undefined); this.postChats(); return;
      }
    } catch (e) {
      this.banner(String(e));
    }
  }

  private async selectModel(id: string): Promise<void> {
    const entry = loadPolicy().find((e) => e.id === id);
    if (!entry) return;
    this.selected = entry;
    this.devModel = null;
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
    } else {
      await this.unloadLocalModel();
    }
    await this.pushStatus();
    this.postContextWindow();
    this.postChatMode();
  }

  private handleAddModel(slug: string): void {
    const reason = explainBlock(slug);
    if (reason) {
      this.stopForPolicyViolation(reason, slug);
      return;
    }
    this.post({ type: 'addAccepted', slug });
  }

  private async targetDeps() {
    const status = this.client ? await this.client.status().catch(() => null) : null;
    return {
      localEndpoint: status?.endpoint ?? undefined,
      openRouterKey: this.deps.secrets.get(OPENROUTER_KEY_ID),
      googleKey: this.deps.secrets.get(GOOGLE_KEY_ID),
    };
  }

  private async currentTarget(): Promise<ResolvedTarget> {
    if (this.devMode && this.devModel) {
      return resolveDevTarget(this.devModel, this.deps.secrets.get(FIREWORKS_KEY_ID) ?? '');
    }
    if (this.selected) {
      if (this.selected.provider === 'local' && !this.client) this.client = await this.deps.connect();
      return resolveTarget(this.selected, await this.targetDeps());
    }
    throw new Error('Pick a model first.');
  }

  private macToolDeps() {
    return {
      approveEdit: (rel: string, isNew: boolean) => this.deps.approveEdit(rel, isNew),
      approveCommand: (command: string) => this.deps.approveCommand(command),
    };
  }

  private async handleSend(text: string): Promise<void> {
    if (this.generating) { this.banner('Still generating — press Stop first.'); this.post({ type: 'restoreInput', text }); return; }
    let target: ResolvedTarget;
    try { target = await this.currentTarget(); }
    catch (e) { this.banner(String(e instanceof Error ? e.message : e)); this.post({ type: 'restoreInput', text }); this.postGenerating(false); return; }
    const params = this.prefs.params();
    if (Object.keys(params).length) target = { ...target, bodyExtra: { ...target.bodyExtra, ...params } };
    const session = this.store.active();
    const ctx = await this.collectContext(text);
    const preamble = buildContextPreamble(ctx);
    const sys = this.systemPromptForChat() + (preamble ? '\n\n---\n' + preamble : '');
    const preTurnLen = session.messages.length;
    session.addUser(text);
    this.post({ type: 'history', messages: session.messages });
    this.generating = new AbortController();
    this.postGenerating(true);
    let usage: Usage | null = null;
    const checkpoint = this.agentMode ? new AgentCheckpoint() : null;
    const root = this.root;
    try {
      if (this.compareModelId) {
        const entry = loadPolicy().find((e) => e.id === this.compareModelId);
        if (entry) {
          const targetB = await resolveTarget(entry, await this.targetDeps());
          const sessionB = new Session();
          sessionB.messages = session.messages.map((m) => ({ ...m }));
          this.post({ type: 'compareStart' });
          await Promise.all([
            (async () => {
              if (this.agentMode && root) {
                await runAgentTurn(target, session, sys, (step) => this.post({ type: 'agentStep', step: `[A] ${step}` }), this.generating!.signal, {
                  extraTools: this.mcpTools, toolExtras: this.toolExtras(checkpoint ?? undefined), workspaceRoot: root,
                  execute: (n, a, w, ex) => executeMacTool(n, a, w, ex, this.macToolDeps()),
                });
              } else {
                const r = await streamChat(target, session.toRequestMessages(sys), (t) => this.post({ type: 'token', text: t }), this.generating!.signal, (t) => this.post({ type: 'reasoning', text: t }));
                session.addAssistant(splitThink(r.content).content || '(no reply)');
                usage = r.usage;
              }
            })(),
            (async () => {
              const r = await streamChat(targetB, sessionB.toRequestMessages(sys), (t) => this.post({ type: 'compareToken', side: 'B', text: t }), this.generating!.signal);
              this.post({ type: 'compareDone', side: 'B', content: splitThink(r.content).content || '(no reply)' });
            })(),
          ]);
          this.post({ type: 'compareDone', side: 'A', content: session.messages[session.messages.length - 1]?.content ?? '' });
        }
      } else if (this.agentMode) {
        if (!root) {
          this.banner('Agent mode needs a project folder. Use File → Open Folder.');
          throw new Error('agent-needs-folder');
        }
        await runAgentTurn(target, session, sys, (step) => this.post({ type: 'agentStep', step }), this.generating.signal, {
          extraTools: this.mcpTools, toolExtras: this.toolExtras(checkpoint ?? undefined), workspaceRoot: root,
          execute: (n, a, w, ex) => executeMacTool(n, a, w, ex, this.macToolDeps()),
        });
      } else {
        const r = await streamChat(target, session.toRequestMessages(sys),
          (t) => this.post({ type: 'token', text: t }), this.generating.signal,
          (t) => this.post({ type: 'reasoning', text: t }));
        session.addAssistant(splitThink(r.content).content || '(no reply)');
        const hits = [
          ...(ctx.codebase ?? []).map(({ file, startLine, endLine }) => ({ file, startLine, endLine })),
          ...(ctx.docs ?? []).map(({ file, startLine, endLine }) => ({ file, startLine, endLine })),
        ];
        if (hits.length) {
          const last = session.messages[session.messages.length - 1];
          last.sources = hits;
        }
        this.post({ type: 'reasoningDone' });
        usage = r.usage;
      }
      this.store.touchTitle();
      this.store.save();
      this.post({ type: 'history', messages: session.messages });
      this.postChats();
      if (usage) this.post({ type: 'usage', usage });
      if (checkpoint?.hasChanges()) { this.lastCheckpoint = checkpoint; this.postAgentUndo(); }
    } catch (e) {
      session.messages.length = preTurnLen;
      this.store.save();
      this.post({ type: 'history', messages: session.messages });
      this.post({ type: 'restoreInput', text });
      this.banner(String(e instanceof Error ? e.message : e));
    } finally {
      this.generating = null;
      this.postGenerating(false);
    }
  }

  dispose(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.ragWatcher) { this.ragWatcher.close(); this.ragWatcher = null; }
    if (this.skillsWatcher) { this.skillsWatcher.close(); this.skillsWatcher = null; }
    for (const c of this.mcpClients) c.dispose();
    this.mcpClients = [];
  }
}
