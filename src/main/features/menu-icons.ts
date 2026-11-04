/**
 * Images for the shell's own menus (tray, dock) and the thumbnail toolbar. A menu draws an
 * item's image at its size in DIP, so an image loaded from a 48 px .ico fills the screen.
 * Each one here is 16 DIP, with the real pixels for the screen's scale beside it.
 */

import { readFileSync } from 'node:fs';
import { nativeImage, type NativeImage } from 'electron';
import { icoBitmaps } from '../../../scripts/ico.mjs';
import { encodePng } from './os-icons';

/** Windows, Linux and macOS menus all draw their images at this. */
export const MENU_ICON_DIP = 16;

function fit(image: NativeImage): NativeImage {
  const { width, height } = image.getSize();
  if (image.isEmpty() || (width <= MENU_ICON_DIP && height <= MENU_ICON_DIP)) return image;
  return image.resize({ width: MENU_ICON_DIP, height: MENU_ICON_DIP, quality: 'best' });
}

/** The .ico's bitmaps as 16 DIP representations: 16 px at 100 %, 32 px at 200 %, and between. */
function icoRepresentations(file: string): { scaleFactor: number; size: number; buffer: Buffer }[] {
  let bitmaps: Map<number, Buffer>;
  try {
    bitmaps = icoBitmaps(readFileSync(file));
  } catch {
    return [];
  }
  return [...bitmaps]
    .filter(([size]) => size >= MENU_ICON_DIP)
    .sort(([a], [b]) => a - b)
    .map(([size, rgba]) => ({ scaleFactor: size / MENU_ICON_DIP, size, buffer: encodePng(rgba, size, size) }));
}

/**
 * A menu item's image. From an .ico (the task icons), one representation per size in it.
 * From a PNG, as Electron loads it with its @2x beside it; a macOS `…Template.png` stays a
 * template. Anything larger than 16 DIP is scaled down.
 */
export function menuIcon(file: string): NativeImage {
  if (file.toLowerCase().endsWith('.ico')) {
    const image = nativeImage.createEmpty();
    for (const { scaleFactor, size, buffer } of icoRepresentations(file)) image.addRepresentation({ scaleFactor, width: size, height: size, buffer });
    return fit(image);
  }
  const image = fit(nativeImage.createFromPath(file));
  if (/Template(@\dx)?\.png$/.test(file)) image.setTemplateImage(true);
  return image;
}

/**
 * A thumbnail toolbar button's image from an .ico: 16 DIP, with only the bitmap for the
 * window's scale. Electron hands Windows one bitmap, the one nearest 1x, so a 16 px one
 * beside it would be stretched on a 200 % screen.
 */
export function thumbIcon(file: string, scaleFactor: number): NativeImage {
  const reps = icoRepresentations(file);
  const rep = reps.find((candidate) => candidate.scaleFactor >= scaleFactor) ?? reps.at(-1);
  const image = nativeImage.createEmpty();
  if (rep) image.addRepresentation({ scaleFactor: rep.scaleFactor, width: rep.size, height: rep.size, buffer: rep.buffer });
  return image;
}
