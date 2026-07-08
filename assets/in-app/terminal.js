/** In-app terminal renderer for FortressChat Mac. */
let sessionId = null;
const container = document.getElementById('term');
const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' },
});
term.open(container);
term.focus();

/** Start a shell session in the given working directory. */
async function startSession(cwd) {
  const info = await window.__fcTerm.create(cwd);
  sessionId = info.id;
  term.writeln(`FortressChat terminal — ${info.shell} in ${info.cwd}`);
  term.writeln('');
}

term.onData((data) => {
  if (sessionId) window.__fcTerm.write(sessionId, data);
});

window.__fcTerm.onData(({ id, data }) => {
  if (id !== sessionId) return;
  term.write(data);
});

window.__fcTerm.onExit(({ id }) => {
  if (id !== sessionId) return;
  term.writeln('\r\n[Process exited]');
  sessionId = null;
});

window.__fcTerm.onInit(({ cwd }) => {
  void startSession(cwd);
});

window.addEventListener('resize', () => {
  term.resize(Math.max(10, Math.floor(container.clientWidth / 8)), Math.max(3, Math.floor(container.clientHeight / 18)));
});

window.addEventListener('beforeunload', () => {
  if (sessionId) window.__fcTerm.kill(sessionId);
});
