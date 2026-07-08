import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { patchMacMedia } from './mac-media-patch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor/fortress-code');
const ASSETS_MEDIA = join(ROOT, 'assets/chat-media');
const PARITY_FILE = join(ASSETS_MEDIA, '.parity.json');
const MAC_VALIDATE = join(ROOT, 'src/main/validateGoogleKey.ts');

/** Prefer a sibling fortress-code checkout; fall back to the vendor submodule. */
export function resolveExtensionRoot() {
  if (process.env.FORTRESS_CODE_ROOT) return process.env.FORTRESS_CODE_ROOT;
  const sibling = join(ROOT, '../fortress-code');
  if (existsSync(join(sibling, 'packages/extension/media/chat.js'))) return sibling;
  return VENDOR;
}

/** Return sha256 hex for a file path. */
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** List relative file paths under dir (recursive). */
function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, base));
    else out.push(relative(base, abs));
  }
  return out.sort();
}

const MAC_OWNED = new Set(['chat.html', 'chat.js', 'chat.css']);

/** Copy extension chat media and Google key validator; write parity manifest. */
export function syncExtensionMedia() {
  const extRoot = resolveExtensionRoot();
  const mediaDir = join(extRoot, 'packages/extension/media');
  const validateSrc = join(extRoot, 'packages/extension/src/providers/validateGoogleKey.ts');
  if (!existsSync(mediaDir)) throw new Error(`Extension media not found at ${mediaDir}`);
  if (!existsSync(validateSrc)) throw new Error(`validateGoogleKey.ts not found at ${validateSrc}`);

  mkdirSync(ASSETS_MEDIA, { recursive: true });
  for (const name of readdirSync(mediaDir)) {
    if (MAC_OWNED.has(name)) continue;
    const src = join(mediaDir, name);
    const dest = join(ASSETS_MEDIA, name);
    if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true });
    else cpSync(src, dest);
  }
  writeFileSync(MAC_VALIDATE, readFileSync(validateSrc));

  const files = {};
  for (const rel of listFiles(ASSETS_MEDIA)) {
    files[rel] = hashFile(join(ASSETS_MEDIA, rel));
  }

  let sourceCommit = 'unknown';
  try { sourceCommit = execSync('git rev-parse HEAD', { cwd: extRoot, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }

  writeFileSync(PARITY_FILE, `${JSON.stringify({
    sourceRoot: extRoot,
    sourceCommit,
    syncedAt: new Date().toISOString(),
    mediaFiles: files,
    validateGoogleKey: hashFile(validateSrc),
  }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncExtensionMedia();
  const patchErrors = patchMacMedia();
  if (patchErrors.length) {
    console.error('Mac media patch failed:\n' + patchErrors.map((e) => `- ${e}`).join('\n'));
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(PARITY_FILE, 'utf8'));
  console.log(`Synced extension media from ${manifest.sourceCommit} (${manifest.sourceRoot})`);
}
