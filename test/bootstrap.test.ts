import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { loadCatalog, isAllowed, loadPolicy } from '@fortress-chat/shared';

describe('bootstrap', () => {
  it('imports shared from the submodule via alias', () => {
    const embed = loadCatalog().find((m) => m.id === 'nomic-embed-text-v1.5');
    expect(embed?.dims).toBe(768);
    expect(loadPolicy().every((e) => typeof isAllowed(e) === 'boolean')).toBe(true);
  });
  it('submodule is present', () => {
    expect(existsSync('vendor/fortress-code/packages/shared/src/index.ts')).toBe(true);
  });
});
