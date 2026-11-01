'use strict';
const config = require('../config');
let transport = null;

function getTransport() {
  if (!config.smtp.host) return null;
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
  }
  return transport;
}

/** Sends one message. Without SMTP_HOST the message is written to the log instead (development / first run). */
async function send({ to, subject, text, messageId, inReplyTo, references, replyTo }) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail:not-sent] SMTP_HOST is not configured. To: ${to} | ${subject}`);
    return { logged: true };
  }
  const headers = {
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'All',
    Precedence: 'bulk',
    'X-ITSM-Notification': '1',
  };
  const info = await t.sendMail({
    from: config.smtp.from, to, subject, text, messageId, replyTo: replyTo || undefined,
    inReplyTo: inReplyTo || undefined, references: references || inReplyTo || undefined, headers,
  });
  return { accepted: info.accepted };
}

module.exports = { send };
