/**
 * Sleep, wake, lock and unlock go to the page, which reconnects and syncs at once. Plus
 * the global "Show Bulwark". Quick compose's shortcut belongs to another feature, so
 * this only ever touches its own accelerator.
 */

import { globalShortcut, powerMonitor } from 'electron';
import { CHANNEL, type OsPowerEvent } from '../../shared/bridge';
import type { OsHub } from './os-hub';

const EVENTS: readonly OsPowerEvent[] = ['suspend', 'resume', 'lock-screen', 'unlock-screen'];

export function setupPower(hub: OsHub): { applyShortcut: () => void } {
  const { windows } = hub.ctx;
  for (const event of EVENTS) {
    powerMonitor.on(event as 'suspend', () => windows.broadcast(CHANNEL.osPower, event));
  }

  let held: string | null = null;
  const applyShortcut = () => {
    const wanted = hub.settings().showShortcut;
    if (held) globalShortcut.unregister(held);
    held = null;
    hub.shortcutActive = false;
    if (!wanted) return;
    try {
      // False: another app holds it. The settings page says so.
      if (globalShortcut.register(wanted, () => hub.ctx.showMain())) {
        held = wanted;
        hub.shortcutActive = true;
      }
    } catch (error) {
      console.warn('Shortcut refused:', error);
    }
  };

  hub.on('settings', (_settings, changed) => {
    if ('showShortcut' in changed) applyShortcut();
  });
  applyShortcut();

  return { applyShortcut };
}
