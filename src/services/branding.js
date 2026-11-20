'use strict';
// Company branding: the company name and logo shown in the application (menu, sign-in page, page titles) and on every document
// (PDF headers and footers, Excel titles). The name is the quote_company.name setting; the logo is one PNG or JPEG in branding_assets.
const crypto = require('crypto');
const settings = require('../lib/settings');
const image = require('../lib/image');
const config = require('../config');
const { UserError } = require('./tickets');

const MAX_BYTES = 1024 * 1024;
let cache = null;                                  // { at, name, logo: { sha, mime, width, height } | null }
let pdfCache = null;                               // { sha, image }
const TTL = 30000;

function invalidate() { cache = null; pdfCache = null; }

/** { name, displayName, logo } — displayName is the company name, or the product name when none is set. */
async function get(db) {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const company = await settings.get(db, 'quote_company', {});
  const name = company && typeof company.name === 'string' ? company.name.trim() : '';
  const row = (await db.query('select sha256, mime, width, height from branding_assets where id = 1')).rows[0];
  const recolor = (await settings.get(db, 'branding_logo_recolor', true)) !== false;
  cache = { at: Date.now(), name, displayName: name || config.appName, recolor, logo: row ? { sha: row.sha256, mime: row.mime, width: row.width, height: row.height } : null };
  return cache;
}

async function setName(db, name) {
  const company = await settings.get(db, 'quote_company', {});
  await settings.set(db, 'quote_company', { ...(company && typeof company === 'object' ? company : {}), name: String(name || '').trim().slice(0, 120) });
  invalidate();
}

/** Check and store an uploaded logo. Returns { width, height }. */
async function setLogo(db, buf, actor) {
  if (!buf || !buf.length) throw new UserError('Choose an image file.');
  if (buf.length > MAX_BYTES) throw new UserError('The logo must be at most 1 MB. Save a smaller version (a few hundred pixels wide is plenty).');
  let info;
  try { info = image.inspect(buf); image.forPdf(buf); } catch (e) { throw new UserError(e.message); }
  if (info.width < 16 || info.height < 16) throw new UserError('The image is too small to be a logo.');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  await db.query(
    `insert into branding_assets (id, mime, data, width, height, sha256, updated_by, updated_at) values (1, $1, $2, $3, $4, $5, $6, now())
     on conflict (id) do update set mime = excluded.mime, data = excluded.data, width = excluded.width, height = excluded.height, sha256 = excluded.sha256, updated_by = excluded.updated_by, updated_at = now()`,
    [info.type === 'png' ? 'image/png' : 'image/jpeg', buf, info.width, info.height, sha, actor ? actor.id : null]);
  invalidate();
  return { width: info.width, height: info.height };
}

async function removeLogo(db) { await db.query('delete from branding_assets where id = 1'); invalidate(); }

async function logoFile(db) {
  return (await db.query('select mime, data, sha256 from branding_assets where id = 1')).rows[0] || null;
}

/** What PDFs need: { name, image } (image prepared once per logo). */
async function forDocuments(db) {
  const b = await get(db);
  let img = null;
  if (b.logo) {
    if (pdfCache && pdfCache.sha === b.logo.sha) img = pdfCache.image;
    else {
      const f = await logoFile(db);
      try { img = f ? image.forPdf(f.data) : null; } catch (_) { img = null; }
      pdfCache = { sha: b.logo.sha, image: img };
    }
  }
  return { name: b.name, displayName: b.displayName, image: img, recolor: !!(img && b.recolor) };
}

module.exports = { MAX_BYTES, get, setName, setLogo, removeLogo, logoFile, forDocuments, invalidate };
