// Рисует иконки приложения без внешних зависимостей: простые скруглённые прямоугольники и PNG через zlib.

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../assets/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const BG = [15, 92, 76];
const BARS = [
  { x: 0.14, w: 0.3, color: [191, 223, 248] },
  { x: 0.47, w: 0.14, color: [214, 205, 246] },
  { x: 0.64, w: 0.22, color: [248, 189, 172] },
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // глубина
  header[9] = 2; // RGB
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const start = y * (size * 3 + 1);
    rows[start] = 0;
    pixels.copy(rows, start + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRounded(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function draw(size, { scale = 1 } = {}) {
  const pixels = Buffer.alloc(size * size * 3);
  const samples = 4;
  const barTop = 0.5 - 0.17 * scale;
  const barHeight = 0.34 * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          let color = BG;
          for (const bar of BARS) {
            const bx = 0.5 + (bar.x - 0.5) * scale;
            if (insideRounded(px, py, bx, barTop, bar.w * scale, barHeight, 0.045 * scale)) color = bar.color;
          }
          sum[0] += color[0];
          sum[1] += color[1];
          sum[2] += color[2];
        }
      }
      const offset = (y * size + x) * 3;
      for (let c = 0; c < 3; c += 1) pixels[offset + c] = Math.round(sum[c] / samples ** 2);
    }
  }
  return encodePng(size, pixels);
}

writeFileSync(new URL('icon-180.png', OUT), draw(180));
writeFileSync(new URL('icon-192.png', OUT), draw(192));
writeFileSync(new URL('icon-512.png', OUT), draw(512));
writeFileSync(new URL('icon-maskable-512.png', OUT), draw(512, { scale: 0.76 }));
writeFileSync(
  new URL('favicon.svg', OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0F5C4C"/><rect x="9" y="21" width="19" height="22" rx="3" fill="#BFDFF8"/><rect x="30" y="21" width="9" height="22" rx="2" fill="#D6CDF6"/><rect x="41" y="21" width="14" height="22" rx="3" fill="#F8BDAC"/></svg>\n`,
);
console.log('Иконки готовы');
