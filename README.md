# FortressChat for Mac

A native macOS app for FortressChat — local-first AI chat with US-only model
governance. This app wraps the shared logic from the
[fortress-chat](https://github.com/curtismu7/fortress-chat) monorepo,
which is included here as a git submodule (`vendor/fortress-chat`), and bundles
its TypeScript sources directly via esbuild.

Built from the fortress-code monorepo via git submodule (`vendor/fortress-code`, pinned on `main`).

When the VS Code extension chat UI or Google key validation changes, refresh Mac parity:

```bash
git submodule update --remote vendor/fortress-code   # optional: bump vendor pin
npm run sync:extension                             # copy media + validateGoogleKey.ts
npm test && npm run build
```

## Feature parity

The Mac app tracks the VS Code extension chat UI and protocol:

- Claude-style model picker, settings drawer, composer `+` menu (modes, skills, MCP, context)
- **Skills** — `SKILL.md` from `fortressChat.skillDirectories` in app settings
- **MCP servers** — stdio tools in Agent mode via `fortressChat.mcpServers` in settings
- Agent mode, plan/debug/multitask, compare models, personas, memory, `@docs`, images, voice (TTS)
- Project rules (`.fortress/rules.md`), agent undo, @-mentions

Edit MCP/skills paths: **Fortress → Edit Settings (MCP + Skills)…** (`~/Library/Application Support/fortress-chat-mac/settings.json`).

Code block **Insert/Apply** copies to the clipboard (no in-app editor). **Open in editor tab** opens a second chat window.


FortressChat for Mac is a native menu-bar-friendly Electron shell around the
same chat UI as the FortressChat VS Code extension: local, US-governed model
chat plus `@codebase` context lookups, backed by the manager daemon from the
`fortress-chat` monorepo. No editor required — it runs standalone.

## Install (prebuilt DMG)

1. Download the latest `FortressChat-<version>-arm64.dmg` from the
   [Releases](https://github.com/curtismu7/fortress-chat-mac/releases) page.
2. Open the DMG and drag `FortressChat.app` into `Applications`.
3. The app is unsigned (no Apple Developer ID yet), so macOS Gatekeeper will
   block a normal double-click launch. Use one of:
   - **Right-click → Open** on `FortressChat.app`, then confirm the "Open"
     dialog (only needed the first time).
   - Or clear the quarantine flag from Terminal:
     ```bash
     xattr -d com.apple.quarantine "/Applications/FortressChat.app"
     ```

## Dev build

```bash
git clone --recurse-submodules https://github.com/curtismu7/fortress-chat-mac
cd fortress-chat-mac
npm install
npm start
```

`npm run dist` produces an unsigned arm64 DMG under `release/`.

Note: VS Code integrated terminals export `ELECTRON_RUN_AS_NODE=1`, which makes
`npm start` run Electron as plain Node (no window). Run
`env -u ELECTRON_RUN_AS_NODE npm start` there, or use a regular terminal.
