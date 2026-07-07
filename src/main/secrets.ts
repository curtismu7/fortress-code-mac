import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const OPENROUTER_KEY_ID = 'fortressChat.openRouterKey';
export const FIREWORKS_KEY_ID = 'fortressChat.fireworksKey';
export const GOOGLE_KEY_ID = 'fortressChat.googleKey';

export interface CryptoBackend {
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  isEncryptionAvailable(): boolean;
}

export class SecretStore {
  private data: Record<string, { enc: boolean; value: string }>;
  constructor(private filePath: string, private backend: CryptoBackend) {
    try { this.data = JSON.parse(readFileSync(filePath, 'utf8')); } catch { this.data = {}; }
  }
  get(id: string): string | undefined {
    const e = this.data[id];
    if (!e) return undefined;
    if (!e.enc) return e.value;
    try { return this.backend.decryptString(Buffer.from(e.value, 'base64')); } catch { return undefined; }
  }
  set(id: string, value: string): void {
    const v = value.trim();
    if (this.backend.isEncryptionAvailable()) {
      this.data[id] = { enc: true, value: this.backend.encryptString(v).toString('base64') };
    } else {
      console.warn('fortress-chat-mac: OS encryption unavailable; storing secret unencrypted');
      this.data[id] = { enc: false, value: v };
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data), { mode: 0o600 });
  }
}
