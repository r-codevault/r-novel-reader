/**
 * make-icon.js — 生成 128x128 插件图标 PNG(无第三方依赖)
 * 用法: node scripts/make-icon.js media/icon.png
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 128;
const H = 128;
const data = Buffer.alloc(W * H * 4); // RGBA, 默认全透明

function px(x, y, r, g, b, a) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) {
    return;
  }
  const i = (y * W + x) * 4;
  const da = data[i + 3] / 255;
  const sa = (a === undefined ? 255 : a) / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) {
    return;
  }
  data[i] = Math.round((r * sa + data[i] * da * (1 - sa)) / oa);
  data[i + 1] = Math.round((g * sa + data[i + 1] * da * (1 - sa)) / oa);
  data[i + 2] = Math.round((b * sa + data[i + 2] * da * (1 - sa)) / oa);
  data[i + 3] = Math.round(oa * 255);
}

function fillRect(x0, y0, x1, y1, r, g, b, a) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      px(x, y, r, g, b, a);
    }
  }
}

function fillRoundRect(x0, y0, x1, y1, radius, r, g, b, a) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = Math.max(x0 + radius, Math.min(x, x1 - radius));
      const cy = Math.max(y0 + radius, Math.min(y, y1 - radius));
      let inside = true;
      if ((x < x0 + radius || x > x1 - radius) && (y < y0 + radius || y > y1 - radius)) {
        const dx = x - cx;
        const dy = y - cy;
        inside = dx * dx + dy * dy <= radius * radius;
      }
      if (inside) {
        px(x, y, r, g, b, a);
      }
    }
  }
}

// ---------- 绘制 ----------
// 书签飘带(先画, 让书本盖住下半部分)
fillRect(84, 10, 98, 36, 224, 82, 82, 255);
// 书封
fillRoundRect(14, 18, 114, 112, 14, 59, 130, 196, 255);
// 书脊
fillRoundRect(14, 18, 36, 112, 14, 44, 95, 158, 255);
fillRect(28, 18, 36, 112, 44, 95, 158, 255);
// 内页
fillRoundRect(42, 30, 106, 100, 6, 235, 242, 250, 255);
// 文字行
fillRoundRect(50, 42, 98, 48, 3, 59, 130, 196, 255);
fillRoundRect(50, 56, 98, 62, 3, 59, 130, 196, 255);
fillRoundRect(50, 70, 98, 76, 3, 59, 130, 196, 255);
fillRoundRect(50, 84, 76, 90, 3, 59, 130, 196, 255);

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), buf]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const stride = 1 + W * 4;
const raw = Buffer.alloc(H * stride);
for (let y = 0; y < H; y++) {
  const off = y * stride;
  raw[off] = 0; // filter: none
  data.copy(raw, off + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2] || path.join(__dirname, '..', 'media', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('icon written:', out, png.length, 'bytes');
