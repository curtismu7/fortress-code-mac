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
  it('two instances over the same file do not clobber each other', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fc-mem-')), 'settings.json');
    const a = new FileMemento(p);
    const b = new FileMemento(p);
    a.update('devMode', true);
    b.update('folder', '/tmp/x');
    const c = new FileMemento(p);
    expect(c.get('devMode')).toBe(true);
    expect(c.get('folder')).toBe('/tmp/x');
  });
  it('array-shaped corrupt file is reset safely', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fc-mem-')), 'state.json');
    writeFileSync(p, '[1,2,3]');
    const m = new FileMemento(p);
    expect(m.get('0')).toBeUndefined();
    m.update('k', 1);
    expect(new FileMemento(p).get('k')).toBe(1);
  });
});
