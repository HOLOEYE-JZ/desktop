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

`ELECTRON_RUN_AS_NODE` must not be set when launching Electron. For a second copy next to a running one: `node scripts/run-electron.mjs . --bulwark-user-data=<dir> --standalone`, or `--instance=<url>`. `--dev` adds the reload and devtools items. These switches only exist in a test build (`node build.mjs --test`, which `npm start` and `npm test` use), never in what ships.

## How it's built

- `src/main/` is the main process. ESM with top-level await: the random port has to be in `--host-resolver-rules` before Chromium's network service starts.
- `src/server/` runs in a utilityProcess: a custom `next()` server on TLS, with a per-install certificate pinned by fingerprint, answering only requests with a per-launch secret that main adds. See `src/server/host.ts`.
- `src/preload/` is the bridge, `window.bulwarkDesktop`. The webmail's side is `lib/desktop/`. `src/shared/bridge.ts` is a copy of the contract in `lib/desktop/types.ts`: change both together.
- `src/main/windows.ts` is the window manager: all app windows go through it.
- `src/main/features/` is where tray, jump lists, toasts, context menus and policies plug in. See `features/index.ts`.
- `src/main/features/import.ts` with `import-scan.ts`, `import-files.ts` and `import-books.ts` finds Thunderbird and Outlook data and gives a page read access to the files the user confirmed, through a `bulwark-import:` scheme that serves ranges from main. Each step asks natively. The disk work runs in `import-worker.ts`, a utilityProcess under a timeout, since a file on the disk can be built to hang.
- `native/` is the native helper: Windows Hello, the OS keystore for S/MIME, and the macOS check for forced preferences. `npm run build:native` needs Rust, and the app runs without it, with those features unavailable. Its exports are in `native/README.md`.

## Policies

Admins set or force settings through `Software\Policies\Bulwark\Desktop` and its `Recommended` subkey, a macOS profile, or `/etc/bulwark/policies.json`. The schema and the ADMX, ADML and samples come from the webmail (`lib/desktop/policy-schema.ts`, `scripts/generate-desktop-policies.mjs`). `src/shared/policy-schema.ts` is a byte-for-byte copy: `node scripts/generate-desktop-policies.mjs --shell <this repo>` in the webmail refreshes it. `src/main/policy-read.ts` reads them, `src/main/features/policies.ts` keeps them live, and pages read them through the bridge's `policy` member.

The installers take the same values: `msiexec /i Bulwark.msi /qn ALLUSERS=1 INSTANCE_URL=https://mail.example.com FORCE_INSTANCE=1 UPDATE_CHANNEL=stable`, or `Bulwark-Setup.exe /S /INSTANCE_URL=https://mail.example.com /FORCE_INSTANCE=1` run as an administrator. Without `FORCE_INSTANCE=1` the values go under `Recommended`.

Limits: these settings stop people from changing them inside the app. The app isn't signed yet, so someone who can write to its folder, or run their own copy, can patch it. Admins who need a hard guarantee also limit what may run, with AppLocker or WDAC, and install per machine with the MSI so standard users can't write to the folder. `AllowedJmapServers` also applies to a Bulwark server the user picks, so list that too.

A production build refuses switches that would script the page or move its traffic (`src/main/switch-guard.ts`), with or without a policy, and restarts itself without them.

Tests use a stand-in root under `HKCU\Software\BulwarkTest\Policies`, only in a test build (`node build.mjs --test`, which `npm test` does). `scripts/after-pack.cjs` refuses to package one.

## Test

```sh
npm run pack:test         # test/fuses.spec.ts and friends: a package that takes --user-data-dir and Playwright
npm run pack:strict       # test/policies-packaged.spec.ts: behaves as production, with its profile compiled in
vw exec --env IT_ENT_PASSWORD="vault://Stalwart test – ent-* throwaway accounts/password" -- npm test
```

`test/` drives the real app with Playwright's Electron support, on a real webmail build.

## Licence

AGPL-3.0-only. See `LICENSE`.
