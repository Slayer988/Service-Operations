'use strict';
const multer = require('multer');
const storage = require('../lib/storage');
const config = require('../config');

storage.ensureDirs();
const upload = multer({ dest: storage.dirs.tmp, limits: { fileSize: 26 * 1048576, files: 5, fields: 40, fieldSize: 100 * 1024 } });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function back(req, res, fallback = '/') {
  const ref = req.get('referer') || '';
  try {
    const u = new URL(ref);
    if (u.origin === new URL(config.baseUrl).origin) return res.redirect(u.pathname + u.search);
  } catch (_) { /* fall through */ }
  return res.redirect(fallback);
}

/** Store uploaded files for a ticket; report rejected ones to the user. */
async function saveUploads(db, req, ticket, user, settingsValues) {
  const blocked = settingsValues.attachment_blocked_ext || [];
  const maxBytes = Number(settingsValues.attachment_max_mb || 10) * 1048576;
  const rejected = [];
  for (const f of req.files || []) {
    const r = await storage.storeFile({ srcPath: f.path, filename: f.originalname, mime: f.mimetype, maxBytes, blockedExt: blocked });
    if (r.rejected) { rejected.push(`${storage.safeName(f.originalname)}: ${r.rejected}`); continue; }
    await db.query(
      `insert into attachments (ticket_id, customer_id, filename, mime, size_bytes, sha256, storage_name, scan_status, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ticket.id, ticket.customer_id, r.filename, r.mime, r.size_bytes, r.sha256, r.storage_name, r.scan_status, user.id]);
  }
  return rejected;
}

/** Comments, history and attachments of a ticket as the given user may see them. */
async function ticketTimeline(db, user, ticket) {
  const staff = user.kind === 'staff';
  const comments = (await db.query(
    `select c.*, u.name as author_name, u.kind as author_kind from ticket_comments c left join users u on u.id = c.author_id
      where c.ticket_id = $1 ${staff ? '' : 'and not c.internal'} order by c.created_at, c.id`, [ticket.id])).rows;
  const events = (await db.query(
    `select e.* from ticket_events e where e.ticket_id = $1 ${staff ? '' : 'and not e.internal'} order by e.created_at, e.id`, [ticket.id])).rows;
  const attachments = (await db.query(
    `select a.id, a.filename, a.size_bytes, a.scan_status, a.created_at from attachments a where a.ticket_id = $1 order by a.id`, [ticket.id])).rows;
  const timeline = [
    ...comments.map((c) => ({ type: 'comment', at: c.created_at, c })),
    ...events.map((e) => ({ type: 'event', at: e.created_at, e })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  return { timeline, attachments };
}

module.exports = { upload, wrap, back, saveUploads, ticketTimeline };
