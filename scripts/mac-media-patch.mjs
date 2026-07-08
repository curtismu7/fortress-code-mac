import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(ROOT, 'assets/chat-media');

const EXPLORER_HTML = `    <section id="file-explorer" class="file-explorer" hidden aria-label="Workspace files">
      <div class="file-explorer-head">
        <span class="file-explorer-title">Explorer</span>
        <button type="button" id="explorer-refresh" class="explorer-refresh" title="Refresh file tree">↻</button>
      </div>
      <div id="explorer-root-name" class="explorer-root-name"></div>
      <div id="file-tree" class="file-tree"></div>
    </section>
`;

/** Ensure Mac-only sidebar explorer markup and handlers survive extension media sync. */
export function patchMacMedia() {
  const errors = [];
  const htmlPath = join(MEDIA, 'chat.html');
  let html = readFileSync(htmlPath, 'utf8');
  if (!html.includes('id="file-explorer"')) {
    if (!html.includes('<nav id="chat-list"')) {
      errors.push('chat.html: chat-list anchor missing');
    } else {
      html = html.replace('<nav id="chat-list"', `${EXPLORER_HTML}    <nav id="chat-list"`);
      writeFileSync(htmlPath, html);
    }
  }

  const jsPath = join(MEDIA, 'chat.js');
  const js = readFileSync(jsPath, 'utf8');
  if (!js.includes('renderWorkspaceExplorer')) {
    errors.push('chat.js: Mac explorer handlers missing — restore from git (do not run sync:extension on chat.js)');
  }

  const cssPath = join(MEDIA, 'chat.css');
  const css = readFileSync(cssPath, 'utf8');
  if (!css.includes('.file-explorer')) {
    errors.push('chat.css: Mac explorer styles missing — restore from git');
  }

  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = patchMacMedia();
  if (errors.length) {
    console.error('Mac media patch failed:\n' + errors.map((e) => `- ${e}`).join('\n'));
    process.exit(1);
  }
  console.log('Mac media patch OK');
}
