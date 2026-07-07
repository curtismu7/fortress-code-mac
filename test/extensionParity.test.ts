import { describe, it, expect } from 'vitest';
import { checkExtensionParity } from '../scripts/check-extension-parity.mjs';

describe('extension parity', () => {
  it('assets/chat-media and validateGoogleKey.ts match vendor extension', () => {
    expect(checkExtensionParity()).toEqual([]);
  });
});
