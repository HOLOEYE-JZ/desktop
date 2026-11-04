// Reads and writes Windows .ico files. Plain 32-bit bitmaps, no PNG inside: every
// version of the shell reads those at every size.

/**
 * An .ico of square RGBA images.
 * @param {{ size: number, rgba: Buffer }[]} images
 * @returns {Buffer}
 */
export function encodeIco(images) {
  const entries = images.map(({ size, rgba }) => {
    if (rgba.length !== size * size * 4) throw new Error(`${size} px: ${rgba.length} bytes of RGBA`);
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    // Twice the height: the colour bitmap, then the AND mask.
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    // Bottom-up BGRA.
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const from = (y * size + x) * 4;
        const to = ((size - 1 - y) * size + x) * 4;
        pixels[to] = rgba[from + 2];
        pixels[to + 1] = rgba[from + 1];
        pixels[to + 2] = rgba[from];
        pixels[to + 3] = rgba[from + 3];
      }
    }
    // All clear: the alpha channel decides.
    const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
    return { size, data: Buffer.concat([header, pixels, mask]) };
  });
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map(({ data }) => data)]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The square sizes in an .ico, or null if it isn't one: a header Windows takes, and each
 * entry's image inside the file and of the size the directory says.
 * @param {Buffer} buffer
 * @returns {number[] | null}
 */
export function icoSizes(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return null;
  const count = buffer.readUInt16LE(4);
  if (count === 0 || buffer.length < 6 + 16 * count) return null;
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + 16 * index;
    const width = buffer.readUInt8(at) || 256;
    const height = buffer.readUInt8(at + 1) || 256;
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (width !== height || length < 40 || offset < 6 + 16 * count || offset + length > buffer.length) return null;
    const image = buffer.subarray(offset, offset + length);
    if (image.subarray(0, 8).equals(PNG)) {
      if (image.length < 24 || image.readUInt32BE(16) !== width || image.readUInt32BE(20) !== height) return null;
    } else {
      const bits = image.readUInt16LE(14);
      if (image.readUInt32LE(0) !== 40 || image.readInt32LE(4) !== width || image.readInt32LE(8) !== height * 2 || image.readUInt16LE(12) !== 1) return null;
      if (bits !== 32 || length < 40 + width * height * 4) return null;
    }
    sizes.push(width);
  }
  return sizes;
}

/**
 * The 32-bit bitmaps in an .ico as RGBA, top row first, by size. Entries stored as PNG are
 * left out: encodeIco never writes them.
 * @param {Buffer} buffer
 * @returns {Map<number, Buffer>}
 */
export function icoBitmaps(buffer) {
  /** @type {Map<number, Buffer>} */
  const found = new Map();
  if (!icoSizes(buffer)) return found;
  const count = buffer.readUInt16LE(4);
  for (let index = 0; index < count; index += 1) {
    const at = 6 + 16 * index;
    const size = buffer.readUInt8(at) || 256;
    const offset = buffer.readUInt32LE(at + 12);
    const image = buffer.subarray(offset, offset + buffer.readUInt32LE(at + 8));
    if (image.subarray(0, 8).equals(PNG)) continue;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // Bottom-up BGRA after the 40 byte header.
        const from = 40 + ((size - 1 - y) * size + x) * 4;
        const to = (y * size + x) * 4;
        rgba[to] = image[from + 2];
        rgba[to + 1] = image[from + 1];
        rgba[to + 2] = image[from];
        rgba[to + 3] = image[from + 3];
      }
    }
    found.set(size, rgba);
  }
  return found;
}
