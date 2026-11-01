'use strict';
// Minimal XLSX (Excel) writer: several sheets, a styled header row, typed columns, frozen header, filters. No dependencies.
const { zip } = require('./zip');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
function colName(i) { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
const safeSheetName = (n, used) => {
  let s = String(n || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let k = 2; const base = s;
  while (used.has(s.toLowerCase())) { s = `${base.slice(0, 28)} ${k++}`; }
  used.add(s.toLowerCase()); return s;
};
// styles: 0 text, 1 header, 2 date, 3 money (#,##0.00), 4 integer, 5 percent (value is already 0-100), 6 title, 7 wrap text
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="#,##0.00"/><numFmt numFmtId="166" formatCode="0.0&quot;%&quot;"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF075F17"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B7A1F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E8E3"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="left" vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function serial(v) {
  // Excel serial day for a date (the calendar day as stored, no time zone shift)
  let y; let m; let d;
  if (v instanceof Date) { y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate(); }
  else { const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); if (!x) return null; y = +x[1]; m = +x[2]; d = +x[3]; }
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function sheetXml(sheet) {
  const cols = sheet.columns; const rows = sheet.rows || [];
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  const titleRows = sheet.title ? 2 : 0;
  const headerRow = titleRows + 1;
  out.push(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>`);
  out.push('<cols>' + cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join('') + '</cols><sheetData>');
  let r = 1;
  if (sheet.title) { out.push(`<row r="1"><c r="A1" s="6" t="inlineStr"><is><t>${esc(sheet.title)}</t></is></c></row>`); r = 3; }
  out.push(`<row r="${r}" ht="22" customHeight="1">` + cols.map((c, i) => `<c r="${colName(i)}${r}" s="1" t="inlineStr"><is><t>${esc(c.header)}</t></is></c>`).join('') + '</row>');
  for (const row of rows) {
    r += 1;
    const cells = cols.map((c, i) => {
      const ref = `${colName(i)}${r}`; const v = row[c.key];
      if (v === null || v === undefined || v === '') return `<c r="${ref}" s="0"/>`;
      if (c.type === 'date') { const n = serial(v); return n === null ? `<c r="${ref}" s="0" t="inlineStr"><is><t>${esc(v)}</t></is></c>` : `<c r="${ref}" s="2"><v>${n}</v></c>`; }
      if (c.type === 'money' || c.type === 'integer' || c.type === 'percent' || c.type === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) return `<c r="${ref}" s="0" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
        return `<c r="${ref}" s="${{ money: 3, integer: 4, percent: 5, number: 0 }[c.type]}"><v>${n}</v></c>`;
      }
      const text = v instanceof Date ? v.toISOString() : String(v);
      return `<c r="${ref}" s="${c.wrap ? 7 : 0}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
    });
    out.push(`<row r="${r}">${cells.join('')}</row>`);
  }
  out.push('</sheetData>');
  if (rows.length) out.push(`<autoFilter ref="A${headerRow}:${colName(cols.length - 1)}${headerRow + rows.length}"/>`);
  out.push('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/></worksheet>');
  return out.join('');
}

/** sheets: [{ name, title?, columns: [{ header, key, width?, type?: text|date|money|integer|percent|number, wrap? }], rows: [{...}] }] -> Buffer */
function workbook(sheets, meta = {}) {
  const list = sheets.length ? sheets : [{ name: 'Report', columns: [{ header: 'No data', key: 'x' }], rows: [] }];
  const used = new Set(); const names = list.map((s) => safeSheetName(s.name, used));
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title || 'Report')}</dc:title><dc:creator>${esc(meta.creator || 'Service Operations (Ops)')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(files);
}

module.exports = { workbook, colName, serial };
