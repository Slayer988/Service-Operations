'use strict';
// Microsoft 365 / Exchange Online through Microsoft Graph, with an app registration (client credentials, no user sign-in, no
// password IMAP). The app needs the application permission Mail.Read (Mail.ReadWrite only if "mark processed mail as read" is on),
// and should be limited to the shared mailboxes with an Exchange Application Access Policy or RBAC for Applications.
// Raw MIME is downloaded and given to the same ingestion code as IMAP, so threading, SPF/DKIM checks and attachments behave the same.
const { FIRST_RUN_DAYS, BATCH, FIRST_RUN_MAX, request, form } = require('./common');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const tokens = new Map();   // mailbox id -> { token, exp }

const HINTS = {
  401: 'Check the tenant ID, application (client) ID and client secret (secrets expire).',
  403: 'The app may not read this mailbox: grant admin consent for Mail.Read, and check any Application Access Policy includes this address.',
  404: 'Mailbox or folder not found: check the address and folder name.',
};

function hint(err) { return err.status && HINTS[err.status] ? `${err.message} — ${HINTS[err.status]}` : err.message; }

async function accessToken(mb, ctx) {
  const hit = tokens.get(mb.id);
  if (hit && hit.exp > Date.now() + 60000 && hit.key === `${mb.tenant_id}|${mb.client_id}`) return hit.token;
  const j = await request(ctx.fetch, `https://login.microsoftonline.com/${encodeURIComponent(mb.tenant_id)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: mb.client_id, client_secret: ctx.env[mb.secret_env], scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (!j.access_token) throw new Error('Microsoft did not return an access token.');
  tokens.set(mb.id, { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000, key: `${mb.tenant_id}|${mb.client_id}` });
  return j.access_token;
}

const WELL_KNOWN = { inbox: 'inbox', junk: 'junkemail', junkemail: 'junkemail', archive: 'archive', drafts: 'drafts', sentitems: 'sentitems' };

async function folderId(mb, ctx, auth) {
  const want = String(mb.imap_folder || 'INBOX').trim();
  const wk = WELL_KNOWN[want.toLowerCase().replace(/[\s_-]/g, '')];
  if (wk) return wk;
  const j = await request(ctx.fetch, `${userBase(mb)}/mailFolders?$filter=${encodeURIComponent(`displayName eq '${want.replace(/'/g, "''")}'`)}&$select=id&$top=2`, { headers: auth });
  if (!j.value || !j.value.length) throw new Error(`Folder "${want}" was not found in ${mb.address}.`);
  return j.value[0].id;
}

function userBase(mb) { return `${GRAPH}/users/${encodeURIComponent(mb.address)}`; }
function iso(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

module.exports = {
  label: 'Microsoft 365 (Graph)',
  accessToken,
  configError(mb, env) {
    if (!mb.address) return 'The mailbox address must be set.';
    if (!/^[A-Za-z0-9.-]{3,100}$/.test(mb.tenant_id || '')) return 'The Microsoft tenant ID (a GUID or your .onmicrosoft.com domain) must be set.';
    if (!/^[0-9a-fA-F-]{36}$/.test(mb.client_id || '')) return 'The application (client) ID must be a GUID.';
    if (!mb.secret_env || !env[mb.secret_env]) return `The client-secret variable ${mb.secret_env || '(none named)'} is not set in the server environment file.`;
    return '';
  },
  secrets(mb, env) { return [env[mb.secret_env]]; },

  async poll(mb, ctx) {
    let auth; let items = [];
    const first = !mb.last_received_at;
    try {
      auth = { Authorization: `Bearer ${await accessToken(mb, ctx)}` };
      const folder = await folderId(mb, ctx, auth);
      const since = first ? new Date(Date.now() - FIRST_RUN_DAYS * 86400000) : new Date(mb.last_received_at);
      let url = `${userBase(mb)}/mailFolders/${encodeURIComponent(folder)}/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${iso(since)}`)}`
        + `&$orderby=${encodeURIComponent('receivedDateTime asc')}&$top=50&$select=id,internetMessageId,receivedDateTime,isRead`;
      const cap = first ? FIRST_RUN_MAX : BATCH;
      for (let page = 0; url && items.length < cap && page < 10; page++) {
        const j = await request(ctx.fetch, url, { headers: auth });
        items = items.concat(j.value || []);
        url = j['@odata.nextLink'] || null;
      }
      items = items.slice(0, cap);
    } catch (err) { err.message = hint(err); throw err; }

    let count = 0;
    let watermark = null;
    for (const m of items) {
      const received = new Date(m.receivedDateTime);
      const skip = (first && m.isRead) || (m.internetMessageId && await ctx.seen(mb, m.internetMessageId));
      if (!skip) {
        const raw = await request(ctx.fetch, `${userBase(mb)}/messages/${encodeURIComponent(m.id)}/$value`, { headers: auth, as: 'buffer' });
        await ctx.ingestSafe(mb, raw, { ref: m.id });
        if (mb.mark_seen && !m.isRead) {
          await request(ctx.fetch, `${userBase(mb)}/messages/${encodeURIComponent(m.id)}`, {
            method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ isRead: true }), as: 'none',
          }).catch((e) => console.error(`[mail] ${mb.key}: could not mark as read: ${e.message}`));
        }
        count++;
      }
      watermark = received;
      await ctx.pool.query(`update mailboxes set last_received_at = greatest(coalesce(last_received_at, '-infinity'), $2) where id = $1`, [mb.id, received]);
    }
    if (first && !watermark) {
      // Nothing in the window: start from five minutes ago (a cushion for clock differences; duplicates are ignored anyway).
      await ctx.pool.query('update mailboxes set last_received_at = $2 where id = $1 and last_received_at is null', [mb.id, new Date(Date.now() - 5 * 60000)]);
    }
    return count;
  },

  async test(mb, ctx) {
    try {
      const auth = { Authorization: `Bearer ${await accessToken(mb, ctx)}` };
      const folder = await folderId(mb, ctx, auth);
      const j = await request(ctx.fetch, `${userBase(mb)}/mailFolders/${encodeURIComponent(folder)}?$select=displayName,totalItemCount,unreadItemCount`, { headers: auth });
      return { ok: true, message: `Connected to Microsoft 365 and opened "${j.displayName}" of ${mb.address}: ${j.totalItemCount} message(s), ${j.unreadItemCount} unread.` };
    } catch (err) { err.message = hint(err); throw err; }
  },
};
