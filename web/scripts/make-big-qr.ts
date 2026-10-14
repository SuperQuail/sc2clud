// 生成一张**真能解码**的 1.3MB PNG（D1 的出图/联调素材：管线要真的 createImageBitmap + canvas 编码）。
// 用随机像素：随机数据不可压缩，所以字节数接近 raw（1200x900x3 = 3.2MB raw → 约 1.2-1.4MB 的 PNG）。
// 用法：node scripts/make-big-qr.ts [目标字节数] [输出路径]
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const target = Number(process.argv[2] ?? 1_300_000);
const out = process.argv[3] ?? join(process.cwd(), '..', 'shots', 'fix-img-fixtures', 'qr-1.3mb.png');

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 逐档加大画布，直到 PNG 的字节数够到目标（随机数据几乎不可压缩，所以一次就差不多）。 */
function build(w: number, h: number): Buffer {
  const raw = randomBytes((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0; // 每行滤波字节 = 0（None）
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色 RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let w = 600;
let png = build(w, 600);
while (png.length < target && w < 3000) {
  w += 20;
  png = build(w, Math.round(w * 0.78));
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(out + '  ' + statSync(out).size + ' 字节  ' + w + 'x' + Math.round(w * 0.78));
