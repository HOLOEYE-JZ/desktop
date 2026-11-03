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
- `src/main/menu.ts` is the app menu. Commands run in the page, through `menu.onCommand` and `lib/desktop/commands.ts` in the webmail. A feature adds its own lines with `menu.extend`. Native right-click menus are the webmail's HTML menus read back: `lib/desktop/native-menu.ts`.
- `src/main/features/` is where tray, jump lists, toasts, context menus and policies plug in. See `features/index.ts`.

## Test

```sh
npm run pack:dir          # for test/fuses.spec.ts
vw exec --env IT_ENT_PASSWORD="vault://Stalwart test – ent-* throwaway accounts/password" -- npm test
```

`test/` drives the real app with Playwright's Electron support, on a real webmail build.

`BULWARK_TEST_WEBMAIL=<dir>` runs the tests on another webmail build, made with `fetch-webmail.mjs --out <dir>`. `test/native-windows.spec.ts` needs one from the same branch. `test/native-timing.spec.ts` is for the bench rig only, and `test/native-screenshots.spec.ts` takes pictures from a real, unlocked desktop.

## Licence

AGPL-3.0-only. See `LICENSE`.
