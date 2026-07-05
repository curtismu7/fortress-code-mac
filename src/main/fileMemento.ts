import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileMemento {
  private data: Record<string, unknown>;
  constructor(private filePath: string) {
    try { this.data = JSON.parse(readFileSync(filePath, 'utf8')); } catch { this.data = {}; }
    if (this.data === null || typeof this.data !== 'object' || Array.isArray(this.data)) this.data = {};
  }
  get(key: string): unknown { return this.data[key]; }
  update(key: string, value: unknown): void {
    // Re-read before writing: multiple FileMemento instances may share one file
    // (e.g. settings.json from main.ts and ChatController) — merging with the
    // on-disk state keeps them from clobbering each other's keys.
    let disk: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) disk = parsed;
    } catch { /* missing/corrupt: start from empty */ }
    this.data = { ...disk, ...this.data, [key]: value };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data));
  }
}
