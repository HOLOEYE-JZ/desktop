# The native helper

What the app can't do from JavaScript: Windows Hello, the OS keystore for S/MIME, and the macOS check for forced preferences. Rust with [napi-rs](https://napi.rs). `npm run build:native` runs cargo and writes `native/dist/<platform>-<arch>/bulwark-native.node`. The binary isn't committed. Node-API is stable across Electron versions, so there's no rebuild per Electron version.

Nothing in here can read a private key or hand one out.

## Exports

This is the whole surface. `test/native.spec.ts` fails if the binary exports anything else, or if this list and the binary differ.

<!-- exports -->
- `helloAvailable()`: promise of a boolean. Whether Windows says a Hello prompt can be shown. False elsewhere.
- `helloVerify(reason, hwnd, timeoutMs)`: shows the Hello prompt on a window. Promise of `verified`, `cancelled`, `busy`, `unavailable`, `timeout`, `invalid` or `failed`. A yes or no that gates the UI: it doesn't unlock or wrap a key. The timeout is required, at most 5 minutes.
- `keystoreList()`: promise of the certificates fit for mail that have a private key. Never prompts, and doesn't touch a smart card.
- `keystoreSign(id, digest, scheme, hwnd?)`: signs a digest. RSA PKCS#1 v1.5 and PSS, ECDSA as DER.
- `keystoreDecrypt(id, data, scheme, hwnd?)`: RSA key transport with OAEP or v1.5. Answers over 64 bytes are refused.
- `keystoreAgree(id, peerPublicKey, hwnd?)`: ECDH, the raw shared secret.
- `policyIsForced(key)`: macOS, whether a configuration profile forces this preference. False elsewhere.
<!-- /exports -->

macOS Touch ID needs no helper: Electron has `systemPreferences.promptTouchID`.

## Hello

Cancelling the WinRT operation doesn't close the Windows Security dialog, which stays up asking for a PIN. So on a timeout the helper posts a close message to the dialogs of class `Credential Dialog Xaml Host` that weren't there before the prompt, skipping any owned by another window. The class name isn't documented: if Windows renames it, a timed-out prompt stays open until the user closes it. `BULWARK_TEST_HELLO_PROMPT=1` runs the one test that shows a real prompt, for a few seconds.

## The keystore

**Which certificates.** Windows `CurrentUser\My`, including smart cards through their minidriver. macOS keychains and tokens. Only those fit for mail: with an extended key usage it has to name email protection or any use, and with a key usage it has to allow signing, key encipherment or key agreement. A sign-in, code signing or CA key in the same store has no id, and can't be used.

**Ids.** The SHA-256 of the certificate. Every call checks the id against the last `keystoreList()`.

**What's checked before the OS sees it.** Id format, digest length for the hash, scheme against key type, key usage against the operation, ciphertext length against the modulus, label size, and the peer key's curve and form. SHA-1 signatures are refused, and SHA-1 stays for OAEP, where old mail needs it.

**Errors** are in the message: `keystore:cancelled`, `keystore:not-found`, `keystore:unsupported`, `keystore:locked`, `keystore:invalid`, `keystore:failed`.

**Windows** goes through CNG. Listing uses the silent flag on software keys, to skip certificates whose key is gone, and leaves cards alone. Sign, decrypt and agree call `CryptAcquireCertificatePrivateKey` with silent off, so the OS's prompts and a card's PIN dialog show as usual. A key behind an old CSP that has no CNG provider answers `keystore:unsupported`. A card's provider may not support OAEP or importing a peer's public key, which is the same answer.

**macOS** goes through `SecKey`. There's no OAEP label there: `keystore:unsupported`.

**Linux** has no keystore in scope. The exports are there and report nothing.

## Build

```sh
npm run build:native                        # this machine
node scripts/build-native.mjs --arch arm64  # needs the Rust target and the MSVC ARM64 libraries
cd native && cargo test                     # the DER reader and the input checks
```

The macOS and Linux code type-checks from any machine:

```sh
rustup target add aarch64-apple-darwin x86_64-unknown-linux-gnu
cd native && cargo check --target aarch64-apple-darwin && cargo check --target x86_64-unknown-linux-gnu
```

Crates: `napi`, `napi-derive`, `napi-build`, `windows` with `windows-core` and `windows-future`, and on macOS `security-framework` with the `security-framework-sys`, `core-foundation` and `core-foundation-sys` it's built on.
