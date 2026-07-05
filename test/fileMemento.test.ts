import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMemento } from '../src/main/fileMemento';

describe('FileMemento', () => {
  it('round-trips values through disk', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fc-mem-')), 'state.json');
    const a = new FileMemento(p);
    a.update('k', { x: 1 });
    const b = new FileMemento(p);
    expect(b.get('k')).toEqual({ x: 1 });
    expect(b.get('missing')).toBeUndefined();
  });
  it('tolerates a corrupt file', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fc-mem-')), 'state.json');
    writeFileSync(p, 'not json');
    expect(new FileMemento(p).get('k')).toBeUndefined();
  });
  it('works with the vendor SessionStore', async () => {
    const { SessionStore } = await import('../vendor/fortress-code/packages/extension/src/sessionStore.js');
    const p = join(mkdtempSync(join(tmpdir(), 'fc-mem-')), 'sessions.json');
    const store = SessionStore.load(new FileMemento(p));
    store.active().addUser('hello');
    store.touchTitle(); store.save();
    const re = SessionStore.load(new FileMemento(p));
    expect(re.active().messages[0]).toMatchObject({ role: 'user', content: 'hello' });
  });
});
