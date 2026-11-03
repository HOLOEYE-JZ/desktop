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

## Packaging

```sh
npm run pack:dir     # release/win-unpacked and so on, no installer
npm run dist:win     # NSIS and MSI, x64 and arm64
npm run dist:mac     # DMG and zip, universal. Run on a Mac.
npm run dist:linux   # AppImage, deb, rpm. Run on Linux.
```

`electron-builder.yml` is the config, `.github/workflows/release.yml` the release: a tag `v<version>` builds everything from a clean checkout, with the webmail built from the tag in `config.webmailTag` in `package.json`. Provenance is a `.sha256` next to each installer and a signed attestation: `gh attestation verify <file> --repo bulwarkmail/desktop`. A hyphen in the tag makes it a prerelease, the beta channel.

- **The server tree is per target.** A webmail build holds sharp for its own machine only. For another architecture, `node scripts/fetch-webmail.mjs --native win32-arm64` adds that one's binaries (macOS universal takes `darwin-x64,darwin-arm64`). `scripts/server-natives.mjs` keeps only what the target runs and fails the build if that's missing. esbuild goes altogether: the embedded server has no use for it.
- **The guard** (`scripts/package-guard.mjs`, run from `scripts/after-pack.cjs`) fails the build on `data/`, `local-data/`, `.env*`, `repos/`, `plugin-signing.key`, links, anything unknown next to the server in `resources/`, or anything but the shell in `app.asar`. It's tested in the real flow by `test/package-guard.spec.ts`.
- **Native modules** in the asar are unpacked next to it (`asarUnpack`). ASAR integrity stays on. The webmail server in `resources/server` isn't covered by it, since it has to be a real folder: that's what signing is for.
- **macOS** is configured but has only been read, not run. Hardened runtime and notarization are driven by env, see the comments in `electron-builder.yml` and `build/entitlements.mac.plist`.
- **Icons** are in `build/`, made from the branding repo by `scripts/make-icons.mjs` and committed.

## Updates

electron-updater reads GitHub Releases of `bulwarkmail/desktop`. It looks 30 seconds after a start, then every 4 hours and after waking up, and downloads by itself. When an update is ready there's "Restart to Update" in the File menu, one notification and a row under Settings > General. It never asks during work. It installs at the next quit or on that item, through the normal quit, so open drafts are saved first and a page that asks to stay calls it off.

What a copy does depends on how it got there:

| Install | Updates |
| --- | --- |
| NSIS, per user | Replaces itself |
| AppImage | Replaces itself |
| MSI, per machine | Says a version exists. An administrator rolls out the new MSI. |
| deb, rpm | Says a version exists, with a link |
| macOS, unsigned | Says a version exists, with a link. Squirrel.Mac refuses unsigned apps. |
| macOS, signed | Replaces itself |

**Channels.** Stable, or beta for prereleases. Going to beta asks first. Going back to stable with a beta running does nothing by itself: the app stays on the beta until stable catches up. The settings page offers "Install older version…", which asks first and says what it can cost. `allowDowngrade` is only ever on for that.

**Tests.** `node scripts/build-update-fixtures.mjs` builds three real installers with the test switches compiled in. `npx playwright test test/updater.spec.ts` installs them on this machine and runs electron-updater's real GitHub provider against a local stand-in. A normal build has no way to set another feed: `test/updater-rules.spec.ts` checks the string isn't there.

### Unsigned builds

Windows builds are unsigned for now.

- **The updater works.** electron-updater checks the publisher only if `app-update.yml` names one, and that comes from a certificate. With none, it skips that check and relies on the sha512 in `latest.yml`, over TLS to GitHub. So what protects an update today is GitHub and TLS. With a certificate configured (the hook in `electron-builder.yml`), new builds refuse an installer from anyone else, and the first signed version installs fine over an unsigned one.
- **SmartScreen.** A browser marks a downloaded file with its origin, and Windows then shows "Windows protected your PC" for an unsigned installer until the file has built up reputation. The user picks "More info", then "Run anyway". The download page and docs have to say so. Updates aren't affected: the file the updater downloads has no such mark (checked by the test), and it needs no elevation.
- **macOS and Linux.** An unsigned DMG gets an ad-hoc signature, and Gatekeeper warns. AppImage, deb and rpm have no such check.

## For administrators

**MSI, per machine.** Installs to Program Files for everyone, writes nothing next to itself, and doesn't update itself. Each user's data stays in their own profile. A newer MSI replaces an older one: the upgrade code in `electron-builder.yml` never changes.

```bat
msiexec /i Bulwark-1.0.0-x64.msi /qn
msiexec /x Bulwark-1.0.0-x64.msi /qn
```

The ARM64 MSI is marked x64 inside, because electron-builder's WiX has no arm64, though the files in it are arm64. Windows 11 on ARM should accept it. It hasn't been tried on one.

**NSIS, per user.** `Bulwark-Setup-1.0.0-x64.exe /S` needs no elevation. Uninstalling leaves the user's mail profile in `%APPDATA%\Bulwark` on purpose: delete the folder to remove it too.

**Policies.** `packaging/bulwark-policies.sample.reg` is a sample to start from, with `AutoUpdate` and `UpdateChannel` set. Import it with `reg import`, or use the ADMX templates. `AutoUpdate=0` stops every request for updates, on any install. Values under `Software\Policies\Bulwark\Desktop` are forced, the same under `\Recommended` are defaults.

**winget.** `packaging/winget/` holds the manifest templates. Fill in the version and the hashes from the release's `.sha256` files, then submit them to `microsoft/winget-pkgs`.

**Checking a download.** Each installer has a `.sha256` next to it, and `gh attestation verify <file> --repo bulwarkmail/desktop` shows which workflow built it from which commit.

## Test

```sh
npm run pack:dir          # for test/fuses.spec.ts
npm run dist:win          # for test/msi.spec.ts
node scripts/build-update-fixtures.mjs   # for test/updater.spec.ts and test/readonly-install.spec.ts
vw exec --env IT_ENT_PASSWORD="vault://Stalwart test – ent-* throwaway accounts/password" -- npm test
```

`test/` drives the real app with Playwright's Electron support, on a real webmail build.

## Licence

AGPL-3.0-only. See `LICENSE`.
