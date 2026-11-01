'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { zip, crc32 } = require('../../src/lib/zip');
const xlsx = require('../../src/lib/xlsx');
const pdf = require('../../src/lib/pdf');

/** read a zip back: name -> Buffer, verifying every CRC and size */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28); const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = zlib.inflateRawSync(buf.slice(start, start + csize));
    assert.equal(data.length, usize); assert.equal(crc32(data), crc);
    out[name] = data; p += 46 + nl;
  }
  return out;
}

test('zip round trip with correct CRCs', () => {
  const files = unzip(zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.xml', data: Buffer.from('<x>é</x>') }]));
  assert.equal(files['a.txt'].toString(), 'hello'); assert.equal(files['dir/b.xml'].toString(), '<x>é</x>');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('xlsx workbook: sheets, typed cells, escaping and safe sheet names', () => {
  const buf = xlsx.workbook([
    { name: 'Contracts: all/any?', title: 'Active', columns: [{ header: 'Ref', key: 'r' }, { header: 'Value', key: 'v', type: 'money' }, { header: 'End', key: 'd', type: 'date' }, { header: 'Note', key: 'n', wrap: true }],
      rows: [{ r: 'CTR-1', v: 1234.5, d: '2026-12-31', n: 'a & b <c>' }, { r: 'CTR-2', v: null, d: new Date(2027, 0, 5), n: 'x\u0001y' }] },
    { name: 'contracts  ALL any', columns: [{ header: 'A', key: 'a', type: 'integer' }], rows: [{ a: 3 }] },
  ]);
  const f = unzip(buf);
  for (const k of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) assert.ok(f[k], k);
  const wb = f['xl/workbook.xml'].toString();
  assert.ok(wb.includes('name="Contracts  all any"') && wb.includes('name="contracts  ALL any 2"'), wb);
  const s1 = f['xl/worksheets/sheet1.xml'].toString();
  assert.ok(s1.includes('a &amp; b &lt;c&gt;') && !s1.includes('\u0001'));
  assert.ok(s1.includes('<v>1234.5</v>'));
  assert.ok(s1.includes(`<v>${xlsx.serial('2026-12-31')}</v>`) && xlsx.serial('2026-12-31') === 46387);
  assert.equal(xlsx.serial('1900-03-01'), 61); assert.equal(xlsx.colName(0), 'A'); assert.equal(xlsx.colName(26), 'AA'); assert.equal(xlsx.colName(27), 'AB');
  assert.ok(s1.includes('<autoFilter ref="A3:D5"/>'));
  assert.equal(xlsx.workbook([]).length > 100, true);
});

test('pdf: valid structure, wrapping and pagination', () => {
  assert.deepEqual(pdf.wrap('one two three', 1000, 10, false), ['one two three']);
  assert.ok(pdf.wrap('word '.repeat(60), 200, 10, false).length > 3);
  assert.ok(pdf.wrap('x'.repeat(300), 100, 10, false).every((l) => pdf.width(l, 10, false) <= 100.5));
  assert.equal(pdf.clean('a—b “q” €'), 'a-b "q" ?');
  const rows = Array.from({ length: 120 }, (_, i) => ({ a: `R${i}`, b: 'text '.repeat(10) }));
  const buf = pdf.document({ title: 'T', blocks: [{ type: 'heading', text: 'H' }, { type: 'kv', rows: [['k', 'v']] }, { type: 'table', columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b', weight: 4 }], rows }] });
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'));
  const pages = (s.match(/\/Type \/Page /g) || []).length; assert.ok(pages >= 3, `pages ${pages}`);
  assert.ok(new RegExp(`/Count ${pages}`).test(s));
  // every xref offset must point at "N 0 obj"
  const start = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(start).startsWith('xref'));
  const entries = [...s.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.ok(s.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.ok(pdf.document({ title: 'Empty', blocks: [{ type: 'table', columns: [{ header: 'A', key: 'a' }], rows: [], empty: 'None' }] }).length > 500);
});
