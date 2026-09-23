import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const wall = [62, 74, 70, 255];
  const card = [232, 235, 228, 255];
  const carbon = [37, 64, 143, 255];
  const left = Math.round(size * 0.22);
  const top = Math.round(size * 0.18);
  const right = Math.round(size * 0.78);
  const bottom = Math.round(size * 0.82);
  const barTop = Math.round(top + (bottom - top) * 0.42);
  const barHeight = Math.max(2, Math.round(size * 0.07));
  const barLeft = Math.round(left + (right - left) * 0.16);
  const barRight = Math.round(left + (right - left) * 0.84);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let pixel = wall;
      if (x >= left && x < right && y >= top && y < bottom) {
        pixel = x >= barLeft && x < barRight && y >= barTop && y < barTop + barHeight ? carbon : card;
      }
      const i = row + 1 + x * 4;
      raw[i] = pixel[0];
      raw[i + 1] = pixel[1];
      raw[i + 2] = pixel[2];
      raw[i + 3] = pixel[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), png(size));
}
