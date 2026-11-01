'use strict';
// Central document repository with versions (CR-005): contracts, tenders, opportunities. A file uploaded again under the same
// name and kind becomes the next version; earlier versions stay available.
const storage = require('../lib/storage');
const settings = require('../lib/settings');

const KINDS = {
  contract: { signed_contract: 'Signed contract', amendment: 'Amendment', schedule: 'Schedule', appendix: 'Appendix', supporting: 'Supporting document' },
  tender: { tender_document: 'Tender document', compliance: 'Compliance document', technical_proposal: 'Technical proposal', financial_proposal: 'Financial proposal', submission: 'Submission', clarification: 'Clarification', award: 'Award notice', supporting: 'Supporting document' },
  opportunity: { proposal: 'Proposal', quotation: 'Quotation', technical: 'Technical document', solution_design: 'Solution design', bom: 'Bill of materials', site_assessment: 'Site assessment', report: 'Report', evidence: 'Engineering evidence', supporting: 'Supporting document' },
};
const COLUMN = { contract: 'contract_id', tender: 'tender_id', opportunity: 'opportunity_id' };

/** files: multer files; target: { type: 'contract'|'tender'|'opportunity', id, customerId }. Returns { stored: [{filename, version}], rejected: [text] } */
async function store(db, files, { type, id, customerId = null, kind = 'supporting', user, taskId = null }) {
  if (!COLUMN[type]) throw new Error('unknown document target');
  const col = COLUMN[type];
  const doc_kind = KINDS[type][kind] ? kind : 'supporting';
  const st = await settings.getAll(db, ['attachment_blocked_ext', 'attachment_max_mb']);
  const stored = []; const rejected = [];
  for (const f of files || []) {
    const s = await storage.storeFile({ srcPath: f.path, filename: f.originalname, mime: f.mimetype, maxBytes: Number(st.attachment_max_mb || 10) * 1048576, blockedExt: st.attachment_blocked_ext || [] });
    if (s.rejected) { rejected.push(`${storage.safeName(f.originalname)}: ${s.rejected}`); continue; }
    const prev = (await db.query(`select coalesce(max(version), 0)::int as v from attachments where ${col} = $1 and lower(filename) = lower($2) and doc_kind = $3`, [id, s.filename, doc_kind])).rows[0].v;
    await db.query(
      `insert into attachments (${col}, opp_task_id, customer_id, filename, mime, size_bytes, sha256, storage_name, scan_status, uploaded_by, doc_kind, version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, taskId, customerId, s.filename, s.mime, s.size_bytes, s.sha256, s.storage_name, s.scan_status, user.id, doc_kind, prev + 1]);
    stored.push({ filename: s.filename, version: prev + 1, kind: doc_kind });
  }
  return { stored, rejected };
}

async function list(db, type, id) {
  const col = COLUMN[type];
  const rows = (await db.query(
    `select a.id, a.filename, a.size_bytes, a.scan_status, a.created_at, a.doc_kind, a.version, u.name as uploader,
            a.version = max(a.version) over (partition by lower(a.filename), a.doc_kind) as latest
       from attachments a left join users u on u.id = a.uploaded_by where a.${col} = $1 order by a.doc_kind, lower(a.filename), a.version desc`, [id])).rows;
  return rows.map((r) => ({ ...r, kind_label: KINDS[type][r.doc_kind] || 'Document' }));
}

module.exports = { KINDS, store, list };
