'use strict';
// Company logo: the PNG/JPEG reader and the branded PDF header.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const image = require('../../src/lib/image');
const pdf = require('../../src/lib/pdf');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
/** A PNG of the given colour type with every row using filter `filter` (0..4 are all exercised by the decoder). */
function png(w, h, colorType, pixel, { depth = 8, filter = 0, plte = null, trns = null } = {}) {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = Math.ceil((w * ch * depth) / 8);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(stride);
    if (depth === 8) for (let x = 0; x < w; x++) Buffer.from(pixel(x, y)).copy(raw, x * ch);
    else for (let x = 0; x < w; x++) { const per = 8 / depth; raw[Math.floor(x / per)] |= pixel(x, y)[0] << ((per - 1 - (x % per)) * depth); }
    // filter 1 (Sub) applied for real so the decoder has to undo it
    const out = Buffer.alloc(stride + 1); out[0] = filter;
    const bpp = Math.max(1, (ch * depth) >> 3);
    for (let i = 0; i < stride; i++) out[i + 1] = filter === 1 ? (raw[i] - (i >= bpp ? raw[i - bpp] : 0)) & 0xff : raw[i];
    rows.push(out);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []), ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function jpeg(w, h, comps = 3) {
  const sof = Buffer.from([0xff, 0xc0, 0, 8 + 3 * comps, 8, h >> 8, h & 255, w >> 8, w & 255, comps, ...Array(3 * comps).fill(1)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), sof, Buffer.from([0xff, 0xd9])]);
}

test('RGBA PNG decodes exactly, with the transparency split into a soft mask', () => {
  const px = (x, y) => [x * 10, y * 20, 200, x === 0 ? 0 : 255];
  const d = image.decodePng(png(4, 3, 6, px, { filter: 1 }));
  assert.strictEqual(d.width, 4); assert.strictEqual(d.colors, 3);
  assert.deepStrictEqual([...d.pixels.subarray(3 * 5, 3 * 6)], [10, 20, 200]);            // pixel (1,1)
  assert.strictEqual(d.alpha[0], 0); assert.strictEqual(d.alpha[1], 255);
  const f = image.forPdf(png(4, 3, 6, px));
  assert.strictEqual(f.colorSpace, '/DeviceRGB'); assert.strictEqual(f.filter, '/FlateDecode'); assert.ok(f.smask);
});

test('opaque RGB, grey, 1-bit and palette PNGs are read', () => {
  assert.strictEqual(image.forPdf(png(20, 20, 2, () => [1, 2, 3])).smask, null);
  const g = image.decodePng(png(16, 16, 0, (x) => [x * 16]));
  assert.strictEqual(g.colors, 1); assert.strictEqual(g.pixels[3], 48);
  const b = image.decodePng(png(16, 16, 0, (x) => [x % 2], { depth: 1 }));
  assert.deepStrictEqual([...b.pixels.subarray(0, 3)], [0, 255, 0]);
  const p = image.decodePng(png(16, 16, 3, (x) => [x % 2], { plte: [255, 0, 0, 0, 0, 255], trns: [0] }));
  assert.deepStrictEqual([...p.pixels.subarray(3, 6)], [0, 0, 255]); assert.strictEqual(p.alpha[0], 0); assert.strictEqual(p.alpha[1], 255);
});

test('JPEG is passed through; other files are refused with a clear message', () => {
  const j = image.forPdf(jpeg(300, 120));
  assert.strictEqual(j.filter, '/DCTDecode'); assert.strictEqual(j.width, 300); assert.strictEqual(j.height, 120);
  assert.strictEqual(image.inspect(jpeg(50, 50, 1)).components, 1);
  assert.throws(() => image.inspect(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), /PNG or JPEG/);
  assert.throws(() => image.inspect(Buffer.from('GIF89a................................')), /PNG or JPEG/);
  assert.throws(() => image.inspect(jpeg(5000, 10)), /4000/);
  assert.throws(() => image.inspect(Buffer.alloc(3)), /empty/);
});

/** All text of a PDF: the raw file plus every Flate stream inflated. */
function pdfText(buf) {
  const s = buf.toString('latin1'); let all = s; const re = /stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length; const end = s.indexOf('endstream', start);
    try { all += zlib.inflateSync(buf.subarray(start, end)).toString('latin1'); } catch (_) { /* image data */ }
  }
  return all;
}

test('a branded PDF carries the logo and the company name; an unbranded one does not', () => {
  const brand = { name: 'Acme Networks Ltd', image: image.forPdf(png(40, 20, 6, () => [0, 100, 200, 255])) };
  const out = pdf.document({ title: 'Ticket report', appName: 'Service Operations', blocks: [{ type: 'p', text: 'Hello' }], brand }); const outT = pdfText(out);
  assert.match(outT, /\/XObject << \/Im1 \d+ 0 R >>/);
  assert.match(outT, /\/Subtype \/Image/);
  assert.ok(outT.includes('Acme Networks Ltd'));
  const plain = pdf.document({ title: 'Ticket report', appName: 'Service Operations', blocks: [{ type: 'p', text: 'Hello' }] }).toString('latin1');
  assert.ok(!plain.includes('/Im1'));
  const nameOnly = pdf.document({ title: 'T', appName: 'Service Operations', blocks: [], brand: { name: 'Acme Networks Ltd', image: null } }); const nT = pdfText(nameOnly);
  assert.ok(nT.includes('Acme Networks Ltd')); assert.ok(!nT.includes('/Im1'));
});

test('logo recolouring: the PDF blends the theme colour over the logo; the screen filter does the same sum', () => {
  const DT = require('../../src/lib/doc_theme');
  const image2 = image.forPdf(png(40, 20, 6, () => [0, 100, 200, 255]));
  const on = pdfText(pdf.document({ title: 'T', blocks: [], palette: DT.PALETTES.sunset, brand: { name: 'Acme', image: image2, recolor: true } }));
  assert.match(on, /\/BM \/Saturation/); assert.match(on, /\/BM \/Screen/);
  assert.ok(on.includes(`/GScr gs ${DT.pdfRgb(DT.PALETTES.sunset.dark)} rg`), 'screened with the sunset colour');
  const off = pdfText(pdf.document({ title: 'T', blocks: [], brand: { name: 'Acme', image: image2, recolor: false } }));
  assert.ok(!off.includes('/BM /Screen') && off.includes('/Im1'), 'switched off: the logo in its own colours');
  // the screen matrix: black -> the tint, white -> white, for every theme
  for (const id of Object.keys(DT.PALETTES)) {
    const m = DT.logoMatrix(DT.logoTint(id)).trim().split(/\s+/).map(Number);
    const apply = (rgb) => [0, 1, 2].map((r) => m[r * 5] * rgb[0] + m[r * 5 + 1] * rgb[1] + m[r * 5 + 2] * rgb[2] + m[r * 5 + 4]);
    const t = [1, 3, 5].map((i) => parseInt(DT.logoTint(id).slice(i, i + 2), 16) / 255);
    apply([0, 0, 0]).forEach((v, i) => assert.ok(Math.abs(v - t[i]) < 0.001, `${id}: black becomes the tint`));
    apply([1, 1, 1]).forEach((v) => assert.ok(Math.abs(v - 1) < 0.001, `${id}: white stays white`));
  }
});
