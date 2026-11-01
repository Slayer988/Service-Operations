'use strict';
// All configuration comes from environment variables (systemd EnvironmentFile). No secrets in source code.
const path = require('path');

function bool(v, d) { if (v === undefined || v === '') return d; return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()); }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const appName = (process.env.APP_NAME || 'Service Operations (Ops)').slice(0, 60);
const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

const config = {
  appName,
  version: require('../package.json').version,
  env: process.env.NODE_ENV || 'production',
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: int(process.env.TRUST_PROXY, 1),
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionIdleHours: int(process.env.SESSION_IDLE_HOURS, 8),
  storageDir: process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'),
  timezone: process.env.APP_TIMEZONE || 'Africa/Nairobi',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || `${appName} <noreply@localhost>`,
  },
  avCommand: process.env.AV_COMMAND || '', // e.g. "clamscan --no-summary"
  lockoutAttempts: int(process.env.LOCKOUT_ATTEMPTS, 5),
  lockoutMinutes: int(process.env.LOCKOUT_MINUTES, 15),
};

config.validate = function validate() {
  if (config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters (see /etc/itsm/itsm.env).');
  }
};

module.exports = config;
