'use strict';
// Minimal PDF report writer: A4, built-in Helvetica, headings, paragraphs, key/value blocks and tables that wrap and paginate.
// No dependencies. Text is limited to the Latin-1 range (other characters become "?").
const zlib = require('zlib');

const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const MAP = { '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '→': '->', '•': '\u0095', ' ': ' ', '≤': '<=', '≥': '>=' };
function clean(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[—–‘’“”…→• ≤≥]/g, (c) => MAP[c])
    .replace(/[\r\t]/g, ' ').replace(/[^\n\x20-\x7e¡-ÿ\u0095]/g, '?');
}
const cw = (ch) => { const c = ch.charCodeAt(0); return c >= 32 && c <= 126 ? W[c - 32] : 556; };
const width = (s, size, bold) => { let t = 0; for (const ch of s) t += cw(ch); return (t / 1000) * size * (bold ? 1.06 : 1); };
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

function wrap(text, maxW, size, bold) {
  const lines = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      let w = word;
      const trial = line ? `${line} ${w}` : w;
      if (width(trial, size, bold) <= maxW) { line = trial; continue; }
      if (line) { lines.push(line); line = ''; }
      while (width(w, size, bold) > maxW && w.length > 1) { // break a very long word
        let k = w.length - 1; while (k > 1 && width(w.slice(0, k), size, bold) > maxW) k -= 1;
        lines.push(w.slice(0, k)); w = w.slice(k);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}

const GREEN = '0.043 0.478 0.122'; const DARK = '0.027 0.373 0.090'; const LIGHT = '0.941 0.973 0.945'; const GREY = '0.365 0.42 0.38';

/**
 * opts: { title, subtitle?, appName?, landscape?: true, blocks: [...] }
 * block: { type:'heading', text } | { type:'p', text } | { type:'kv', rows:[[label, value]] }
 *      | { type:'table', columns:[{header,key,weight?,align?:'right'}], rows:[{...}], empty?: text } | { type:'space', h }
 */
function document(opts) {
  const landscape = opts.landscape !== false;
  const PW = landscape ? 841.89 : 595.28; const PH = landscape ? 595.28 : 841.89; const M = 40;
  const pages = []; let ops = []; let y = 0;
  const top = PH - 52;
  function newPage() {
    ops = []; y = top;
    ops.push(`${GREEN} rg 0 ${PH - 30} ${PW} 30 re f`);
    text(M, PH - 20, clean(opts.title || 'Report'), 13, true, '1 1 1');
    if (opts.subtitle) text(PW - M - width(clean(opts.subtitle), 9), PH - 19, clean(opts.subtitle), 9, false, '1 1 1');
  }
  function text(x, yy, s, size, bold, color) { ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color || '0.06 0.1 0.07'} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`); }
  function ensure(h) { if (y - h < M + 14) { pages.push(ops); newPage(); return true; } return false; }
  newPage();
  for (const b of opts.blocks || []) {
    if (b.type === 'space') { y -= b.h || 10; continue; }
    if (b.type === 'heading') {
      ensure(84); y -= 8; text(M, y - 12, clean(b.text), 12.5, true, DARK); y -= 18;
      ops.push(`${GREEN} RG 0.8 w ${M} ${y - 1} m ${PW - M} ${y - 1} l S`); y -= 8; continue;
    }
    if (b.type === 'p') {
      for (const ln of wrap(b.text, PW - 2 * M, 10, false)) { ensure(14); text(M, y - 10, ln, 10, false); y -= 13.5; }
      y -= 4; continue;
    }
    if (b.type === 'kv') {
      const lw = 150; const vw = PW - 2 * M - lw - 10;
      for (const [k, v] of b.rows) {
        const lines = wrap(v === null || v === undefined || v === '' ? '-' : v, vw, 10, false); const h = Math.max(1, lines.length) * 13 + 3;
        ensure(h); text(M, y - 10, clean(k), 9.5, true, GREY);
        lines.forEach((ln, i) => text(M + lw, y - 10 - i * 13, ln, 10, false));
        y -= h;
      }
      y -= 4; continue;
    }
    if (b.type === 'table') {
      const cols = b.columns; const total = cols.reduce((a, c) => a + (c.weight || 1), 0); const avail = PW - 2 * M;
      const xs = []; let acc = M; const ws = cols.map((c) => ((c.weight || 1) / total) * avail);
      ws.forEach((w) => { xs.push(acc); acc += w; });
      const pad = 4; const size = 8.5;
      const drawHeader = () => {
        const hl = cols.map((c, i) => wrap(c.header, ws[i] - 2 * pad, size, true)); const h = Math.max(...hl.map((l) => l.length)) * 11 + 8;
        ensure(h + 24);
        ops.push(`${GREEN} rg ${M} ${y - h} ${avail} ${h} re f`);
        hl.forEach((lines, i) => lines.forEach((ln, k) => text(c(i).align === 'right' ? xs[i] + ws[i] - pad - width(ln, size, true) : xs[i] + pad, y - 11 - k * 11, ln, size, true, '1 1 1')));
        y -= h;
      };
      const c = (i) => cols[i];
      if (!b.rows.length) { ensure(30); text(M, y - 14, clean(b.empty || 'No records.'), 10, false, GREY); y -= 26; continue; }
      drawHeader();
      b.rows.forEach((row, ri) => {
        const cells = cols.map((col, i) => wrap(row[col.key] === null || row[col.key] === undefined || row[col.key] === '' ? '-' : row[col.key], ws[i] - 2 * pad, size, false));
        const h = Math.max(...cells.map((l) => l.length)) * 11 + 7;
        if (y - h < M + 14) { pages.push(ops); newPage(); drawHeader(); }
        if (ri % 2) ops.push(`${LIGHT} rg ${M} ${y - h} ${avail} ${h} re f`);
        cells.forEach((lines, i) => lines.forEach((ln, k) => text(cols[i].align === 'right' ? xs[i] + ws[i] - pad - width(ln, size, false) : xs[i] + pad, y - 10 - k * 11, ln, size, false)));
        y -= h;
      });
      ops.push(`0.89 0.91 0.89 RG 0.5 w ${M} ${y} m ${PW - M} ${y} l S`); y -= 10; continue;
    }
  }
  pages.push(ops);

  // assemble the file
  const objs = []; const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(''); const pagesObj = add(''); const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const generated = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const kids = pages.map((p, i) => {
    const footer = `BT /F1 8 Tf ${GREY} rg ${M} 22 Td (${esc(clean(`${opts.appName || 'Service Operations (Ops)'}  |  generated ${generated}`))}) Tj ET BT /F1 8 Tf ${GREY} rg ${PW - M - 50} 22 Td (Page ${i + 1} of ${pages.length}) Tj ET`;
    const content = Buffer.from(`${p.join('\n')}\n${footer}`, 'latin1'); const z = zlib.deflateSync(content);
    const cobj = add({ stream: z, dict: `/Length ${z.length} /Filter /FlateDecode` });
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW.toFixed(2)} ${PH.toFixed(2)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cobj} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(clean(opts.title || 'Report'))}) /Producer (Service Operations) >>`);
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offsets = []; let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const body = typeof o === 'string' ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(body); pos += body.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { xref += `${String(o).padStart(10, '0')} 00000 n \n`; });
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { document, wrap, width, clean };
