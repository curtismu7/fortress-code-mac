/** In-app file editor renderer for FortressChat Mac. */
let filePath = '';
const pathEl = document.getElementById('editor-path');
const bodyEl = document.getElementById('editor-body');
const statusEl = document.getElementById('editor-status');
const saveBtn = document.getElementById('editor-save');

/** Show a short status message under the editor. */
function setStatus(text, isError) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', !!isError);
}

/** Scroll the textarea to a 1-based line number. */
function scrollToLine(line) {
  if (!bodyEl || line <= 1) return;
  const lines = bodyEl.value.split('\n');
  const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
  const offset = lines.slice(0, idx).join('\n').length;
  bodyEl.focus();
  bodyEl.setSelectionRange(offset, offset);
  const lineHeight = 18;
  bodyEl.scrollTop = Math.max(0, (idx - 3) * lineHeight);
}

window.__fcEditor.on((msg) => {
  if (msg.type !== 'load') return;
  filePath = msg.path || '';
  if (pathEl) pathEl.textContent = filePath;
  if (bodyEl) bodyEl.value = msg.content || '';
  scrollToLine(Number(msg.startLine) || 1);
});

if (saveBtn) {
  saveBtn.onclick = async () => {
    if (!filePath || !bodyEl) return;
    try {
      await window.__fcEditor.save(filePath, bodyEl.value);
      setStatus('Saved.', false);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
  };
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveBtn?.click();
  }
});
