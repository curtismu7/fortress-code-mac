# Fortress Code for Mac

A native macOS app for Fortress Code — local-first AI chat with US-only model
governance. This app wraps the shared logic from the
[fortress-code](https://github.com/curtismu7/fortress-code) monorepo,
which is included here as a git submodule (`vendor/fortress-code`), and bundles
its TypeScript sources directly via esbuild.

Built from the fortress-code monorepo via git submodule.

## What it does

Fortress Code for Mac is a native menu-bar-friendly Electron shell around the
same chat UI as the Fortress Code VS Code extension: local, US-governed model
chat plus `@codebase` context lookups, backed by the manager daemon from the
`fortress-code` monorepo. No editor required — it runs standalone.

## Install (prebuilt DMG)

1. Download the latest `Fortress Code-<version>-arm64.dmg` from the
   [Releases](https://github.com/curtismu7/fortress-code-mac/releases) page.
2. Open the DMG and drag `Fortress Code.app` into `Applications`.
3. The app is unsigned (no Apple Developer ID yet), so macOS Gatekeeper will
   block a normal double-click launch. Use one of:
   - **Right-click → Open** on `Fortress Code.app`, then confirm the "Open"
     dialog (only needed the first time).
   - Or clear the quarantine flag from Terminal:
     ```bash
     xattr -d com.apple.quarantine "/Applications/Fortress Code.app"
     ```

## Dev build

```bash
git clone --recurse-submodules https://github.com/curtismu7/fortress-code-mac
cd fortress-code-mac
npm install
npm start
```

`npm run dist` produces an unsigned arm64 DMG under `release/`.
