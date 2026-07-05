// Minimal ambient types so vendored modules with type-only vscode imports
// typecheck without @types/vscode. Runtime never loads 'vscode'.
declare module 'vscode' {
  export interface Memento { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> | void }
  export interface SecretStorage { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; delete(key: string): Thenable<void> }
}
interface Thenable<T> extends PromiseLike<T> {}
