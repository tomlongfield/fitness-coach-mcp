// One-off build step, not run at server startup: packs the pre-rendered
// favicon-16.png/favicon-32.png into a single multi-resolution favicon.ico.
// Modern ICO files can embed PNG-compressed images directly (valid since
// Windows Vista, supported by every browser that matters) — no need for a
// real BMP encoder or an image-processing dependency just for this.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const sizes = [16, 32];
const images = sizes.map((size) => ({ size, data: readFileSync(path.join(publicDir, `favicon-${size}.png`)) }));

const headerSize = 6;
const entrySize = 16;
const dirEntries = Buffer.alloc(entrySize * images.length);
let offset = headerSize + entrySize * images.length;
const chunks = [];

images.forEach(({ size, data }, i) => {
  const entry = Buffer.alloc(entrySize);
  entry.writeUInt8(size === 256 ? 0 : size, 0); // width (0 means 256)
  entry.writeUInt8(size === 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // color palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(data.length, 8); // image data size
  entry.writeUInt32LE(offset, 12); // offset of image data
  entry.copy(dirEntries, i * entrySize);
  offset += data.length;
  chunks.push(data);
});

const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(images.length, 4); // image count

const ico = Buffer.concat([header, dirEntries, ...chunks]);
writeFileSync(path.join(publicDir, 'favicon.ico'), ico);
console.log(`Wrote public/favicon.ico (${ico.length} bytes, ${images.length} sizes: ${sizes.join(', ')})`);
