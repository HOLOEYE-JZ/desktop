/**
 * No unsandboxed mail client. Mail and plugin pages run in that sandbox, so without it a
 * bug in Chromium is a way into the user's account.
 *
 * An AppImage has no SUID helper, so it depends on user namespaces. Where those are blocked
 * (Ubuntu 24.04 by default) electron-builder's AppRun adds --no-sandbox by itself and starts
 * the app, whatever our config says. So it's checked here. A deb or rpm brings the helper.
 */

export function sandboxRefused(facts: { platform: NodeJS.Platform; appImage?: string; noSandboxSwitch: boolean; disableSandboxEnv?: string }): boolean {
  if (facts.platform !== 'linux' || !facts.appImage) return false;
  return facts.noSandboxSwitch || Boolean(facts.disableSandboxEnv);
}
