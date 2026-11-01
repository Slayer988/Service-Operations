'use strict';
// One report definition, four outputs: on-screen table, CSV, Excel and PDF (CR-009, CR-010).
const u = require('./util');
const xlsx = require('./xlsx');
const pdf = require('./pdf');
const config = require('../config');

const FORMATS = ['html', 'csv', 'xlsx', 'pdf'];
const fileSafe = (s) => String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';

const plain = (v, c) => {
  if (v === null || v === undefined) return '';
  if (c.type === 'date') return v instanceof Date ? [v.getFullYear(), String(v.getMonth() + 1).padStart(2, '0'), String(v.getDate()).padStart(2, '0')].join('-') : String(v).slice(0, 10);
  if (c.type === 'money') return Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  if (c.type === 'percent') return Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : String(v);
  return String(v);
};

/**
 * report: { title, subtitle?, columns: [{ key, header, type?, width?, weight? }], rows: [], summary?: [[label, value]] }
 * Sends the file in `format` and returns true; returns false for 'html' (the caller renders the page).
 */
function send(res, format, report, user) {
  if (!FORMATS.includes(format) || format === 'html') return false;
  const base = `${fileSafe(report.title)}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.csv"` });
    res.send(u.toCsv(report.rows, report.columns.map((c) => ({ key: c.key, label: c.header }))));
    return true;
  }
  if (format === 'xlsx') {
    const buf = xlsx.workbook([{ name: report.title, title: report.title, columns: report.columns.map((c) => ({ ...c, width: c.width || 18, type: c.type === 'money' || c.type === 'date' || c.type === 'integer' || c.type === 'percent' ? c.type : undefined })), rows: report.rows }],
      { title: report.title, creator: user ? user.name : undefined });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${base}.xlsx"` });
    res.send(buf);
    return true;
  }
  const blocks = [];
  if (report.summary && report.summary.length) blocks.push({ type: 'kv', rows: report.summary });
  blocks.push({ type: 'table', columns: report.columns.map((c) => ({ header: c.header, key: c.key, weight: c.weight || 1, align: c.type === 'money' || c.type === 'integer' || c.type === 'percent' ? 'right' : undefined })),
    rows: report.rows.map((r) => Object.fromEntries(report.columns.map((c) => [c.key, plain(r[c.key], c)]))), empty: 'No records match this report.' });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${base}.pdf"` });
  res.send(pdf.document({ title: report.title, subtitle: report.subtitle, appName: config.appName, blocks }));
  return true;
}

/** Display text for a cell in the HTML table. */
const cell = plain;

module.exports = { FORMATS, send, cell, fileSafe };
