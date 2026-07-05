import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, OPENROUTER_KEY_ID } from '../src/main/secrets';

const fakeBackend = {
  encryptString: (s: string) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
  isEncryptionAvailable: () => true,
};

describe('SecretStore', () => {
  it('stores encrypted (not plaintext on disk) and round-trips', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fc-sec-')), 'secrets.json');
    const s = new SecretStore(p, fakeBackend);
    s.set(OPENROUTER_KEY_ID, 'sk-test-123');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(p, 'utf8')).not.toContain('sk-test-123');
    expect(new SecretStore(p, fakeBackend).get(OPENROUTER_KEY_ID)).toBe('sk-test-123');
  });
});
