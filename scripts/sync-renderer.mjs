import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function replaceOrThrow(html, search, replacement, label) {
  if (!html.includes(search)) {
    throw new Error(`sync-renderer: anchor missing for ${label}: ${JSON.stringify(search)}`);
  }
  return html.replaceAll(search, replacement);
}

export function syncRenderer(vendorMediaDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const f of ['chat.js', 'chat.css']) cpSync(join(vendorMediaDir, f), join(outDir, f)); // byte-identical
  for (const f of ['vscode-shim.js', 'theme.css']) cpSync(join(HERE, '..', 'assets', f), join(outDir, f));
  cpSync(join(vendorMediaDir, 'vendor'), join(outDir, 'vendor'), { recursive: true }); // katex/mermaid — chat.html references these via relative paths

  let html = readFileSync(join(vendorMediaDir, 'chat.html'), 'utf8');

  html = replaceOrThrow(html, '{cspSource}', "'self'", 'CSP {cspSource}');
  html = replaceOrThrow(
    html,
    '<link rel="stylesheet" href="chat.css" />',
    '<link rel="stylesheet" href="chat.css" />\n  <link rel="stylesheet" href="theme.css" />',
    'chat.css <link> tag'
  );
  html = replaceOrThrow(
    html,
    '<script src="chat.js"></script>',
    '<script src="vscode-shim.js"></script>\n  <script src="chat.js"></script>',
    'chat.js <script> tag'
  );

  writeFileSync(join(outDir, 'chat.html'), html);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRenderer('vendor/fortress-code/packages/extension/media', 'renderer');
}
