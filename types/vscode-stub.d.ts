// Minimal ambient types so vendored modules with vscode imports typecheck without @types/vscode.
declare module 'vscode' {
  export interface Memento { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> | void }
  export interface SecretStorage { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; delete(key: string): Thenable<void> }

  export class Uri {
    static file(path: string): Uri;
    static parse(value: string): Uri;
    fsPath: string;
    with(parts: { scheme?: string; path?: string }): Uri;
  }

  export class WorkspaceEdit {
    createFile(uri: Uri, options?: { overwrite?: boolean; contents?: Buffer }): void;
  }

  export class Range {
    constructor(startLine: number, startCol: number, endLine: number, endCol: number);
  }

  export class Selection extends Range {}

  export const TextEditorRevealType: { InCenter: number };
  export const DiagnosticSeverity: { Error: string; Warning: string; Information: string; Hint: string };
  export const ConfigurationTarget: { Global: number; Workspace: number; WorkspaceFolder: number };
  export const ProgressLocation: { Notification: number };

  export const workspace: {
    workspaceFolders?: { uri: Uri; name: string }[];
    registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(): string }): { dispose(): void };
    applyEdit(edit: WorkspaceEdit): Thenable<boolean>;
    fs: { writeFile(uri: Uri, content: Buffer): Thenable<void> };
    asRelativePath(path: string): string;
    getConfiguration(section?: string): { get<T>(key: string, defaultValue?: T): T; update(key: string, value: unknown, target?: number): Thenable<void> };
    createFileSystemWatcher(pattern: string | { base: Uri; pattern: string }): { onDidChange(fn: (u: Uri) => void): void; onDidCreate(fn: (u: Uri) => void): void; onDidDelete(fn: (u: Uri) => void): void; dispose(): void };
    onDidChangeConfiguration(listener: (e: { affectsConfiguration(s: string): boolean }) => void): { dispose(): void };
    openTextDocument(path: string | Uri): Thenable<{ lineCount: number; lineAt(n: number): { text: string; range: Range }; getText(range?: Range): string; offsetAt(pos: { line: number; character: number }): number; fileName: string; languageId: string; uri: Uri }>;
  };

  export const window: {
    showInformationMessage(message: string, options?: { modal?: boolean }, ...items: string[]): Thenable<string | undefined>;
    showWarningMessage(message: string, options?: { modal?: boolean }, ...items: string[]): Thenable<string | undefined>;
    showOpenDialog(options?: object): Thenable<Uri[] | undefined>;
    showSaveDialog(options?: object): Thenable<Uri | undefined>;
    activeTextEditor?: {
      document: { fileName: string; languageId: string; uri: Uri; getText(range?: Range): string; lineAt(n: number): { range: Range }; offsetAt(pos: { line: number; character: number }): number };
      selection: { isEmpty: boolean; active: { line: number; character: number }; start: { line: number; character: number }; end: { line: number; character: number } };
      edit(fn: (b: { insert(pos: { line: number; character: number }, text: string): void }) => void): Thenable<boolean>;
      revealRange(range: Range, type?: number): void;
    };
    onDidChangeActiveTextEditor(listener: () => void): { dispose(): void };
    onDidChangeTextEditorSelection(listener: () => void): { dispose(): void };
    createWebviewPanel(id: string, title: string, viewColumn: number, options: object): { webview: Webview; onDidDispose(fn: () => void): void; dispose(): void };
    registerWebviewViewProvider(id: string, provider: unknown): { dispose(): void };
    withProgress<T>(options: object, task: (progress: unknown, token: { onCancellationRequested(fn: () => void): void }) => Thenable<T>): Thenable<T>;
  };

  export const commands: {
    executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
    getCommands(filterInternal?: boolean): Thenable<string[]>;
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void };
  };

  export const languages: { getDiagnostics(uri?: Uri): { range: { start: { line: number; character: number } }; severity: string; message: string }[] };

  export interface Webview {
    html: string;
    cspSource: string;
    options: object;
    postMessage(msg: unknown): Thenable<boolean>;
    onDidReceiveMessage(listener: (msg: unknown) => void): { dispose(): void };
    asWebviewUri(localResource: Uri): Uri;
  }

  export class RelativePattern {
    constructor(base: Uri, pattern: string);
  }

  export const ViewColumn: { Beside: number };
  export const ExtensionMode: { Development: number; Production: number };
  export function joinPath(base: Uri, ...pathSegments: string[]): Uri;
}

interface Thenable<T> extends PromiseLike<T> {}
