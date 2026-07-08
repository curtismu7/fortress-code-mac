import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMemento } from '../src/main/fileMemento';
import {
  defaultModelsDirectory,
  getModelsDirectory,
  isModelsDirectoryConfirmed,
  markModelsDirectoryConfirmed,
  setModelsDirectory,
} from '../src/main/modelsDirectory';

describe('modelsDirectory', () => {
  it('treats unset storage as unconfirmed', () => {
    const settings = new FileMemento(join(mkdtempSync(join(tmpdir(), 'fc-models-')), 'settings.json'));
    expect(isModelsDirectoryConfirmed(settings)).toBe(false);
  });

  it('marks default or custom paths as confirmed', () => {
    const settings = new FileMemento(join(mkdtempSync(join(tmpdir(), 'fc-models-')), 'settings.json'));
    markModelsDirectoryConfirmed(settings);
    expect(isModelsDirectoryConfirmed(settings)).toBe(true);
    expect(getModelsDirectory(settings)).toBe('');
    expect(defaultModelsDirectory()).toContain('fortress-chat');
    setModelsDirectory(settings, '/tmp/my-models');
    expect(isModelsDirectoryConfirmed(settings)).toBe(true);
    expect(getModelsDirectory(settings)).toBe('/tmp/my-models');
  });
});
