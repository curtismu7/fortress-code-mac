import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor/fortress-code');
const REQUIRED = [
  'packages/shared/src/index.ts',
  'packages/extension/src/rag/service.ts',
  'packages/manager/src/index.ts',
];

/** Return true when a vendor file is readable (more reliable than existsSync on submodules). */
function vendorReadable(rel) {
  try { readFileSync(join(VENDOR, rel)); return true; } catch { return false; }
}

const missing = REQUIRED.filter((rel) => !vendorReadable(rel));
if (missing.length) {
  console.error('Vendor submodule is missing or incomplete. Run:\n  git submodule update --init --recursive');
  console.error('Missing:', missing.join(', '));
  process.exit(1);
}
