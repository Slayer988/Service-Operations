'use strict';
// Just enough of PNG and JPEG to check an uploaded logo and put it in a PDF. Nothing is executed or rendered: the bytes are only
// parsed. PNG is decoded to raw pixels (8-bit, any colour type, not interlaced) so its transparency can go into the PDF as a soft mask;
// JPEG is passed through as it is (PDFs read baseline and progressive JPEG directly).
const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** { type: 'png'|'jpeg', width, height, ... } or throws with a message a person can act on. */
function inspect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) throw new Error('The file is empty or not an image.');
  if (buf.subarray(0, 8).equals(PNG_SIG)) return pngInfo(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegInfo(buf);
  throw new Error('Use a PNG or JPEG image (an SVG, GIF, WebP or other file is not accepted).');
}

function chunks(buf) {
  const out = []; let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error('The PNG file is damaged.');
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function pngInfo(buf) {
  const cs = chunks(buf);
  const ihdr = cs.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) throw new Error('The PNG file is damaged.');
  const width = ihdr.data.readUInt32BE(0); const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8]; const colorType = ihdr.data[9]; const interlace = ihdr.data[12];
  if (!width || !height || width > 4000 || height > 4000) throw new Error('The image must be at most 4000 x 4000 pixels.');
  if (interlace) throw new Error('Interlaced PNG images are not supported. Save it again without interlacing.');
  const okDepth = colorType === 3 || colorType === 0 ? [1, 2, 4, 8].includes(depth) : depth === 8;
  if (![0, 2, 3, 4, 6].includes(colorType) || !okDepth) throw new Error('Use an ordinary 8-bit PNG (16-bit images are not supported).');
  return { type: 'png', width, height, depth, colorType, chunks: cs };
}

function jpegInfo(buf) {
  let p = 2;
  while (p + 4 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue; }
    const marker = buf[p + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(p + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const height = buf.readUInt16BE(p + 5); const width = buf.readUInt16BE(p + 7); const comps = buf[p + 9];
      if (!width || !height || width > 4000 || height > 4000) throw new Error('The image must be at most 4000 x 4000 pixels.');
      if (![1, 3].includes(comps)) throw new Error('Use an RGB or greyscale JPEG (CMYK is not supported).');
      return { type: 'jpeg', width, height, components: comps };
    }
    p += 2 + len;
  }
  throw new Error('The JPEG file is damaged or of a kind that is not supported.');
}

/** PNG to raw pixels: { width, height, colors: 1|3, pixels: Buffer, alpha: Buffer|null } (8 bits per component). */
function decodePng(buf) {
  const info = pngInfo(buf);
  const { width, height, depth, colorType } = info;
  const idat = Buffer.concat(info.chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  let raw;
  try { raw = zlib.inflateSync(idat); } catch (e) { throw new Error('The PNG file is damaged.'); }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = Math.max(1, (channels * depth) >> 3);                   // bytes per pixel for filtering
  const stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < (stride + 1) * height) throw new Error('The PNG file is damaged.');
  const out = Buffer.alloc(stride * height);
  for (let r = 0; r < height; r++) {
    const f = raw[r * (stride + 1)]; const src = r * (stride + 1) + 1; const dst = r * stride; const prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]; const a = i >= bpp ? out[dst + i - bpp] : 0; const b = r ? out[prev + i] : 0; const c = r && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error('The PNG file is damaged.');
      out[dst + i] = v & 0xff;
    }
  }
  const n = width * height;
  if (colorType === 3) {                                                  // palette: expand, with tRNS transparency
    const plte = info.chunks.find((c) => c.type === 'PLTE'); const trns = info.chunks.find((c) => c.type === 'tRNS');
    if (!plte) throw new Error('The PNG file is damaged.');
    const pixels = Buffer.alloc(n * 3); const alpha = trns ? Buffer.alloc(n, 255) : null; const perByte = 8 / depth; const mask = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = out[y * stride + Math.floor(x / perByte)]; const idx = (byte >> ((perByte - 1 - (x % perByte)) * depth)) & mask;
        plte.data.copy(pixels, (y * width + x) * 3, idx * 3, idx * 3 + 3);
        if (alpha && idx < trns.data.length) alpha[y * width + x] = trns.data[idx];
      }
    }
    return { width, height, colors: 3, pixels, alpha };
  }
  if (colorType === 0 && depth < 8) {                                    // 1, 2 or 4-bit grey: spread to 0-255
    const pixels = Buffer.alloc(n); const perByte = 8 / depth; const mask = (1 << depth) - 1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = (out[y * stride + Math.floor(x / perByte)] >> ((perByte - 1 - (x % perByte)) * depth)) & mask;
      pixels[y * width + x] = Math.round((v * 255) / mask);
    }
    return { width, height, colors: 1, pixels, alpha: null };
  }
  if (colorType === 0 || colorType === 2) return { width, height, colors: channels, pixels: out, alpha: null };
  const colors = colorType === 4 ? 1 : 3;                                  // grey + alpha, or RGBA: split the alpha off
  const pixels = Buffer.alloc(n * colors); const alpha = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    out.copy(pixels, i * colors, i * (colors + 1), i * (colors + 1) + colors);
    alpha[i] = out[i * (colors + 1) + colors];
  }
  return { width, height, colors, pixels, alpha: alpha.every((v) => v === 255) ? null : alpha };
}

/** An image ready for the PDF writer: { width, height, colorSpace, filter, data, smask } */
function forPdf(buf) {
  const info = inspect(buf);
  if (info.type === 'jpeg') return { width: info.width, height: info.height, colorSpace: info.components === 1 ? '/DeviceGray' : '/DeviceRGB', filter: '/DCTDecode', data: buf, smask: null };
  const d = decodePng(buf);
  return {
    width: d.width, height: d.height, colorSpace: d.colors === 1 ? '/DeviceGray' : '/DeviceRGB', filter: '/FlateDecode', data: zlib.deflateSync(d.pixels),
    smask: d.alpha ? zlib.deflateSync(d.alpha) : null,
  };
}

module.exports = { inspect, decodePng, forPdf };
