import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileMemento {
  private data: Record<string, unknown>;
  constructor(private filePath: string) {
    try { this.data = JSON.parse(readFileSync(filePath, 'utf8')); } catch { this.data = {}; }
    if (this.data === null || typeof this.data !== 'object') this.data = {};
  }
  get(key: string): unknown { return this.data[key]; }
  update(key: string, value: unknown): void {
    this.data[key] = value;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data));
  }
}
