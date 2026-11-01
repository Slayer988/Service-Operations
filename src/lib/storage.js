'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const av = require('./av');

const dirs = {
  tmp: path.join(config.storageDir, 'tmp'),
  files: path.join(config.storageDir, 'attachments'),
  mail: path.join(config.storageDir, 'inbound'),
};
function ensureDirs() { for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o750 }); }

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001F"\\/<>:|?*]/g, '_').trim();
  return (base || 'file').slice(0, 180);
}
function extOf(name) { const m = /\.([A-Za-z0-9]{1,10})$/.exec(name); return m ? m[1].toLowerCase() : ''; }

/**
 * Validate and store one file (already on disk or in memory). Returns the row values for `attachments`,
 * or { rejected: reason }. Blocked types and oversize files are refused (EMAIL-008).
 */
async function storeFile({ srcPath, buffer, filename, mime, maxBytes, blockedExt }) {
  const name = safeName(filename);
  const ext = extOf(name);
  if (blockedExt.includes(ext)) return { rejected: `File type .${ext} is not allowed` };
  const data = buffer || await fsp.readFile(srcPath);
  if (data.length > maxBytes) return { rejected: `File is larger than ${Math.round(maxBytes / 1048576)} MB` };
  if (data.length === 0) return { rejected: 'File is empty' };
  ensureDirs();
  const storageName = crypto.randomBytes(24).toString('hex');
  const dest = path.join(dirs.files, storageName);
  await fsp.writeFile(dest, data, { mode: 0o640, flag: 'wx' });
  const scan = await av.scan(dest);
  if (scan === 'infected') {
    await fsp.unlink(dest).catch(() => {});
    return { rejected: 'File failed the malware scan' };
  }
  return {
    filename: name, mime: String(mime || 'application/octet-stream').slice(0, 120), size_bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'), storage_name: storageName, scan_status: scan,
  };
}

function attachmentPath(storageName) {
  if (!/^[a-f0-9]{48}$/.test(storageName)) throw new Error('bad storage name');
  return path.join(dirs.files, storageName);
}
async function saveRaw(buffer) {
  ensureDirs();
  const name = crypto.randomBytes(24).toString('hex') + '.eml';
  await fsp.writeFile(path.join(dirs.mail, name), buffer, { mode: 0o640, flag: 'wx' });
  return name;
}
async function readRaw(name) {
  if (!/^[a-f0-9]{48}\.eml$/.test(name)) throw new Error('bad raw name');
  return fsp.readFile(path.join(dirs.mail, name));
}
async function removeTmp(files) {
  for (const f of files || []) await fsp.unlink(f.path).catch(() => {});
}

module.exports = { dirs, ensureDirs, storeFile, attachmentPath, saveRaw, readRaw, removeTmp, safeName };
