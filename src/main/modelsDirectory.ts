import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FileMemento } from './fileMemento';

export const MODELS_DIR_KEY = 'fortressChat.modelsDirectory';
export const MODELS_DIR_CONFIRMED_KEY = 'fortressChat.modelsDirectoryConfirmed';

const DEFAULT_MODELS_DIR = join(homedir(), 'Library', 'Application Support', 'fortress-chat', 'models');

function dataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'fortress-chat');
}

function modelsDirConfigFile(): string {
  return join(dataDir(), 'models-dir.txt');
}

/** Default local models folder when no custom path is set. */
export function defaultModelsDirectory(): string {
  return DEFAULT_MODELS_DIR;
}

/** Whether the user has confirmed where local models are stored. */
export function isModelsDirectoryConfirmed(settings: FileMemento): boolean {
  if (settings.get(MODELS_DIR_CONFIRMED_KEY) === true) return true;
  return !!getModelsDirectory(settings);
}

/** Mark models storage location as confirmed by the user. */
export function markModelsDirectoryConfirmed(settings: FileMemento): void {
  settings.update(MODELS_DIR_CONFIRMED_KEY, true);
}

/** Read configured models directory from Mac settings.json. */
export function getModelsDirectory(settings: FileMemento): string {
  const value = settings.get(MODELS_DIR_KEY);
  return typeof value === 'string' ? value.trim() : '';
}

/** Persist models directory to settings and daemon config file. */
export function setModelsDirectory(settings: FileMemento, dir: string): void {
  const value = dir.trim();
  settings.update(MODELS_DIR_KEY, value || undefined);
  writeModelsDirOverride(value || null);
}

/** Write or clear models-dir.txt for the llama.cpp daemon. */
export function writeModelsDirOverride(dir: string | null): void {
  const root = dataDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const file = modelsDirConfigFile();
  if (!dir?.trim()) {
    try { unlinkSync(file); } catch { /* already absent */ }
    return;
  }
  writeFileSync(file, `${dir.trim()}\n`, { mode: 0o600 });
}

/** Sync settings → daemon config file on startup. */
export function syncModelsDirectoryConfig(settings: FileMemento): void {
  writeModelsDirOverride(getModelsDirectory(settings) || null);
}

/** Read override path from daemon config file. */
export function readModelsDirOverride(): string | null {
  try {
    const file = modelsDirConfigFile();
    if (!existsSync(file)) return null;
    const value = readFileSync(file, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}
