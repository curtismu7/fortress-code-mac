import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_MEDIA = join(ROOT, 'assets/chat-media');
const PARITY_FILE = join(ASSETS_MEDIA, '.parity.json');
const MAC_VALIDATE = join(ROOT, 'src/main/validateGoogleKey.ts');

/** Return sha256 hex for a file path. */
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Fail when pinned Mac assets drift from the last extension sync manifest. */
export function checkExtensionParity() {
  if (!existsSync(PARITY_FILE)) {
    return ['assets/chat-media/.parity.json (run npm run sync:extension)'];
  }
  const manifest = JSON.parse(readFileSync(PARITY_FILE, 'utf8'));
  const mismatches = [];

  for (const [rel, expected] of Object.entries(manifest.mediaFiles ?? {})) {
    const path = join(ASSETS_MEDIA, rel);
    try {
      if (hashFile(path) !== expected) mismatches.push(rel);
    } catch {
      mismatches.push(`${rel} (missing)`);
    }
  }

  try {
    if (hashFile(MAC_VALIDATE) !== manifest.validateGoogleKey) {
      mismatches.push('src/main/validateGoogleKey.ts');
    }
  } catch {
    mismatches.push('src/main/validateGoogleKey.ts (missing)');
  }

  return mismatches;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mismatches = checkExtensionParity();
  if (mismatches.length) {
    console.error('Extension/Mac parity check failed. Run: npm run sync:extension');
    console.error('Drift:', mismatches.join(', '));
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(PARITY_FILE, 'utf8'));
  console.log(`Extension/Mac parity OK (fortress-code @ ${manifest.sourceCommit})`);
}
