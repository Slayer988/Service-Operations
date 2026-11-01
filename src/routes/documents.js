'use strict';
// Download of stored documents: access follows the record the document belongs to.
const express = require('express');
const fs = require('fs');
const { q } = require('../db');
const perms = require('../lib/perms');
const storage = require('../lib/storage');
const u = require('../lib/util');
const audit = require('../lib/audit');
const { wrap } = require('./util');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();

router.get('/documents/:id', requireStaff, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const a = id ? (await q('select * from attachments where id = $1', [id])).rows[0] : null;
  const gone = () => res.status(404).render('error', { title: 'Not found', message: 'File not found.' });
  if (!a) return gone();
  let allowed = false;
  if (a.contract_id) allowed = perms.can(req.user, 'contract.view');
  else if (a.tender_id) allowed = perms.can(req.user, 'tender.view');
  else if (a.opportunity_id) {
    allowed = perms.can(req.user, 'pipeline.view');
    if (!allowed && perms.can(req.user, 'pipeline.support')) allowed = (await q('select 1 from opportunity_engineers where opportunity_id = $1 and user_id = $2', [a.opportunity_id, req.user.id])).rows.length > 0;
  } else if (a.renewal_id) allowed = perms.can(req.user, 'contract.view');
  if (!allowed) return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to this document.' });
  if (a.scan_status === 'infected') return gone();
  const file = storage.attachmentPath(a.storage_name);
  if (!fs.existsSync(file)) return res.status(404).render('error', { title: 'Not found', message: 'The stored file is missing.' });
  await audit({ query: q }, req.user, 'document_downloaded', 'document', id, a.filename, a.customer_id, req.ip);
  res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`, 'Content-Security-Policy': "default-src 'none'" });
  return res.sendFile(file);
}));

module.exports = router;
