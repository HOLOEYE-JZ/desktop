# Bulwark Desktop

The Bulwark desktop app: a thin Electron shell around the webmail. Most of the code lives in the webmail. This repo has the main process, the preload bridge, the server host and packaging.

## Two modes

- **Standalone.** Any JMAP server, no Bulwark instance needed. The webmail's Next server runs inside the app.
- **Instance.** A window on a Bulwark instance URL, with the same bridge exposed only to that origin.

The first run asks which one. The File menu changes it later.

## Develop

```sh
npm install
# A desktop build of the webmail: run `npm run build:desktop` in a webmail checkout first.
node scripts/fetch-webmail.mjs --path ../path/to/webmail
npm start
```

`ELECTRON_RUN_AS_NODE` must not be set when launching Electron. For a second copy next to a running one: `node scripts/run-electron.mjs . --bulwark-user-data=<dir> --standalone`, or `--instance=<url>`. `--dev` adds the reload and devtools items, in an unpackaged run only.

## How it's built

- `src/main/` is the main process. ESM with top-level await: the random port has to be in `--host-resolver-rules` before Chromium's network service starts.
- `src/server/` runs in a utilityProcess: a custom `next()` server on TLS, with a per-install certificate pinned by fingerprint, answering only requests with a per-launch secret that main adds. See `src/server/host.ts`.
- `src/preload/` is the bridge, `window.bulwarkDesktop`. The webmail's side is `lib/desktop/`. `src/shared/bridge.ts` is a copy of the contract in `lib/desktop/types.ts`: change both together.
- `src/main/windows.ts` is the window manager: all app windows go through it.
- `src/main/features/` is where tray, jump lists, toasts, context menus and policies plug in. See `features/index.ts`.
- `native/` is the native helper: Windows Hello, the OS keystore for S/MIME, and the macOS check for forced preferences. `npm run build:native` needs Rust, and the app runs without it, with those features unavailable. Its exports are in `native/README.md`.

## Test

```sh
npm run pack:dir          # for test/fuses.spec.ts
vw exec --env IT_ENT_PASSWORD="vault://Stalwart test – ent-* throwaway accounts/password" -- npm test
```

`test/` drives the real app with Playwright's Electron support, on a real webmail build.

## Licence

AGPL-3.0-only. See `LICENSE`.
