'use strict';
// Generic IMAP (password) provider. Follows messages by UID, not by the "unread" flag, so a person opening a message in
// Outlook cannot hide it from us. Microsoft 365 no longer allows password IMAP for most tenants: use the Graph provider there.
const { FIRST_RUN_DAYS, BATCH, FIRST_RUN_MAX } = require('./common');

function client(mb, password) {
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({
    host: mb.imap_host, port: mb.imap_port, secure: mb.imap_tls,
    auth: { user: mb.imap_user, pass: password }, logger: false, socketTimeout: 60000,
  });
  c.on('error', () => {});   // surfaced through the awaited calls
  return c;
}

module.exports = {
  label: 'IMAP (password)',
  configError(mb, env) {
    if (!mb.imap_host || !mb.imap_user) return 'IMAP server and user must be set.';
    if (!mb.secret_env || !env[mb.secret_env]) return `The password variable ${mb.secret_env || '(none named)'} is not set in the server environment file.`;
    return '';
  },
  secrets(mb, env) { return [env[mb.secret_env]]; },

  async poll(mb, ctx) {
    const c = client(mb, ctx.env[mb.secret_env]);
    let count = 0;
    try {
      await c.connect();
      const lock = await c.getMailboxLock(mb.imap_folder || 'INBOX');
      try {
        const validity = String(c.mailbox.uidValidity);
        const baseline = Number(c.mailbox.uidNext) - 1;
        const known = mb.uid_validity === validity && mb.last_uid !== null && mb.last_uid !== undefined;
        const last = known ? Number(mb.last_uid) : null;
        let uids;
        if (!known) {
          const since = new Date(Date.now() - FIRST_RUN_DAYS * 86400000);
          uids = ((await c.search({ seen: false, since }, { uid: true })) || []).sort((a, b) => a - b).slice(-FIRST_RUN_MAX);
        } else {
          uids = ((await c.search({ uid: `${last + 1}:*` }, { uid: true })) || []).filter((x) => x > last).sort((a, b) => a - b).slice(0, BATCH);
        }
        for (const uid of uids) {
          const msg = await c.fetchOne(uid, { source: true }, { uid: true });
          if (msg && msg.source) {
            await ctx.ingestSafe(mb, msg.source, { ref: `${validity}:${uid}`, uid });
            if (mb.mark_seen) await c.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            count++;
          }
          if (known) await ctx.pool.query('update mailboxes set last_uid = greatest(coalesce(last_uid, 0), $2) where id = $1', [mb.id, uid]);
        }
        if (!known) await ctx.pool.query('update mailboxes set last_uid = $2, uid_validity = $3 where id = $1', [mb.id, Math.max(baseline, 0), validity]);
      } finally { lock.release(); }
      await c.logout();
    } catch (err) {
      try { c.close(); } catch (_) { /* ignore */ }
      throw err;
    }
    return count;
  },

  async test(mb, ctx) {
    const c = client(mb, ctx.env[mb.secret_env]);
    try {
      await c.connect();
      const lock = await c.getMailboxLock(mb.imap_folder || 'INBOX');
      try {
        const unseen = ((await c.search({ seen: false }, { uid: true })) || []).length;
        return { ok: true, message: `Signed in and opened "${mb.imap_folder || 'INBOX'}": ${c.mailbox.exists} message(s), ${unseen} unread.` };
      } finally { lock.release(); await c.logout(); }
    } catch (err) {
      try { c.close(); } catch (_) { /* ignore */ }
      throw err;
    }
  },
};
