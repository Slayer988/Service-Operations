'use strict';
// Sends one message. The mail server comes from the settings saved on the E-mail page (or, for an earlier install, from SMTP_* in the
// environment file) and is read for every message, so a change applies at once, in the web service and in the worker.
const outgoing = require('../services/outgoing');

let factory = (options) => require('nodemailer').createTransport(options);   // tests replace this
let cached = { key: null, transport: null };

function transportFor(options) {
  const key = JSON.stringify(options);
  if (cached.key !== key) cached = { key, transport: factory(options) };
  return cached.transport;
}

/** Sends through the given working configuration (see outgoing.effective). Throws when the mail server refuses. */
async function deliver(eff, { to, subject, text, messageId, inReplyTo, references, replyTo }) {
  const headers = {
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'All',
    Precedence: 'bulk',
    'X-ITSM-Notification': '1',
  };
  const info = await transportFor(eff.options).sendMail({
    from: eff.from, to, subject, text, messageId, replyTo: replyTo || undefined,
    inReplyTo: inReplyTo || undefined, references: references || inReplyTo || undefined, headers,
  });
  return { accepted: info.accepted };
}

/** Sends one message. With no mail server set up the message is written to the log instead (first run), and nobody receives it. */
async function send(message) {
  const { q } = require('../db');
  const eff = await outgoing.effective({ query: q });
  if (eff.source === 'none') {
    console.log(`[mail:not-sent] Outgoing mail is not set up (Administration > E-mail). To: ${message.to} | ${message.subject}`);
    return { logged: true };
  }
  return deliver(eff, message);
}

module.exports = { send, deliver, setTransportFactory: (f) => { factory = f; cached = { key: null, transport: null }; } };
