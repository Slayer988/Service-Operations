'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const config = require('./config');
const branding = require('./services/branding');
const markdown = require('./lib/markdown');
const slaView = require('./lib/sla_view');
const { pool, q } = require('./db');
const csrf = require('./lib/csrf');
const auth = require('./middleware/auth');
const tickets = require('./services/tickets');
const priorityLib = require('./lib/priority');
const perms = require('./lib/perms');
const nav = require('./lib/nav');
const themes = require('./lib/themes');
const user_admin = (u) => require('./lib/admin_tiles').tiles(u).length > 0;
const dashboard = require('./services/dashboard');

const MULTIPART_ROUTES = [/^\/tickets\/new$/, /^\/tickets\/[A-Z]+-\d{6}\/comment$/, /^\/portal\/tickets\/new$/, /^\/portal\/tickets\/[A-Z]+-\d{6}\/comment$/, /^\/(contracts|tenders|pipeline)\/\d+\/files$/,
  /^\/suppliers\/\d+\/documents$/, /^\/lpo\/\d+\/files$/, /^\/admin\/branding\/logo$/];

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');
  // the screen version of the logo recolouring: one SVG colour filter per theme (see lib/doc_theme.js and the icon sprite)
  { const DT = require('./lib/doc_theme'); app.locals.logoFilters = Object.keys(DT.PALETTES).map((id) => ({ id, values: DT.logoMatrix(DT.logoTint(id)) })); }

  app.get('/branding/logo', async (req, res) => {
    try {
      const f = await branding.logoFile({ query: q });
      if (!f) return res.status(404).type('text/plain').send('no logo');
      if (req.headers['if-none-match'] === `"${f.sha256}"`) return res.status(304).end();
      res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=300', ETag: `"${f.sha256}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline' });
      return res.send(f.data);
    } catch (_) { return res.status(503).type('text/plain').send('unavailable'); }
  });

  app.get('/healthz', async (req, res) => {
    try { await q('select 1'); res.type('text/plain').send('ok'); } catch (_) { res.status(503).type('text/plain').send('database unavailable'); }
  });

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cache-Control': 'no-store',
    });
    if (config.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false, setHeaders: (r) => r.set('Cache-Control', 'public, max-age=3600') }));
  app.use(express.urlencoded({ extended: false, limit: '300kb' }));

  app.use(session({
    name: 'itsm.sid',
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: config.sessionSecret, resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', maxAge: config.sessionIdleMinutes * 60 * 1000 },     // rolling: every request starts the idle time again
  }));

  app.use((req, res, next) => {
    const render = res.render.bind(res);
    res.render = (view, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = undefined; }
      return render(view, view === 'error' ? { ...(opts || {}), code: res.statusCode } : opts, cb);
    };
    next();
  });

  app.use((req, res, next) => {
    req.flash = (type, msg) => { (req.session.flash = req.session.flash || []).push({ type, msg }); };
    res.locals.flash = req.session.flash || [];
    if (req.session.flash) req.session.flash = [];
    res.locals.csrfToken = csrf.token(req);
    res.locals.user = null;
    res.locals.can = () => false;
    res.locals.baseUrl = config.baseUrl;
    res.locals.appName = config.appName;
    res.locals.appVersion = config.version;
    res.locals.currentPath = req.path;
    res.locals.nav = [];
    res.locals.alerts = { items: [], count: 0 };
    next();
  });

  // CSRF: multipart bodies are only accepted on the upload routes, which verify the token after parsing.
  app.use((req, res, next) => {
    const ct = String(req.headers['content-type'] || '');
    if (req.method !== 'GET' && ct.startsWith('multipart/form-data')) {
      if (MULTIPART_ROUTES.some((re) => re.test(req.path))) return next();
      return res.status(400).render('error', { title: 'Request rejected', message: 'This form does not accept file uploads.' });
    }
    return csrf.protect(req, res, next);
  });

  app.use(auth.loadUser);
  app.use(auth.enforcePasswordChange);
  app.use(auth.enforceMfaEnrolment);
  // colour theme: own choice, else (signed out) the one remembered in this browser, else green; and whether the side menu is collapsed
  app.use(async (req, res, next) => {
    try {
      const cookieTheme = themes.valid(/(?:^|;\s*)itsm\.theme=([a-z]+)/.exec(req.headers.cookie || '')?.[1]);
      res.locals.theme = themes.resolve(req.user ? req.user.theme : cookieTheme);
      res.locals.navCollapsed = /(?:^|;\s*)itsm\.nav=collapsed(?:;|$)/.test(req.headers.cookie || '');
      res.locals.themes = themes.THEMES;
      // company branding: name and logo for the pages, and what documents need (PDF header and footer, Excel titles)
      try {
        res.locals.brand = await branding.get({ query: q });
        res.locals.docBrand = await branding.forDocuments({ query: q });
      } catch (_) {                                  // never let branding stop a page: fall back to the product name
        res.locals.brand = { name: '', displayName: config.appName, logo: null }; res.locals.docBrand = { name: '', displayName: config.appName, image: null };
      }
      res.locals.currentUrl = req.originalUrl;
      next();
    } catch (err) { next(err); }
  });

  const tz = config.timezone;
  const dt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const dOnly = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' });
  const dDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
  app.use((req, res, next) => {
    res.locals.fmt = {
      dt: (d) => (d ? dt.format(new Date(d)) : '—'),
      // a calendar day ('YYYY-MM-DD') is shown as is; a timestamp is shown in the application's time zone
      date: (d) => (!d ? '—' : /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? dDay.format(new Date(`${d}T00:00:00Z`)) : dOnly.format(new Date(d))),
      iso: (d) => (!d ? '' : /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? String(d) : new Date(d).toISOString().slice(0, 10)),
      size: (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'),
      // formatted text (comments, notes, descriptions written with the editor): safe HTML; everything else is shown as written
      rich: (body, base) => markdown.render(body, { base: base || '/kb' }),
    };
    res.locals.slaView = slaView.view;
    res.locals.statusLabels = tickets.STATUS_LABELS;
    res.locals.priorityLabels = priorityLib.LABELS;
    res.locals.levelLabels = priorityLib.LEVELS;
    res.locals.roleLabels = perms.ROLE_LABELS;
    res.locals.slaState = (due, met, paused) => {
      if (!due) return { text: 'n/a', cls: '' };
      if (met) return new Date(met) <= new Date(due) ? { text: 'Met', cls: 'ok' } : { text: 'Missed', cls: 'bad' };
      if (paused) return { text: 'Paused', cls: 'warn' };
      return new Date() > new Date(due) ? { text: 'Breached', cls: 'bad' } : { text: 'Running', cls: '' };
    };
    res.locals.timezone = tz;
    res.locals.title = '';
    next();
  });

  // Sidebar menu and the bell in the top bar (pages only; not the JSON/API or download routes).
  app.use(async (req, res, next) => {
    try {
      if (req.user && req.method === 'GET' && !req.path.startsWith('/api/') && !/\/files\/|^\/attachments\//.test(req.path)) {
        const alerts = await dashboard.alerts(q, req.user);
        res.locals.alerts = alerts;
        res.locals.adminLinks = user_admin(req.user);
        let approver = false; let waiting = 0;
        if (req.user.kind === 'staff') {
          const A = require('./services/approvals');
          approver = await A.isApprover({ query: q }, req.user);
          if (approver) waiting = (await A.waitingFor({ query: q }, req.user)).length;
          if (waiting) { alerts.items.unshift({ text: `${waiting} approval${waiting === 1 ? ' is' : 's are'} waiting for you`, href: '/approvals' }); alerts.count = alerts.items.length; }
        }
        res.locals.nav = nav.build(req.user, { path: req.path, query: req.query }, { verification: alerts.verification || 0, approver, approvals: waiting });
      }
      next();
    } catch (err) { next(err); }
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/guest'));
  app.use('/portal', require('./routes/portal'));
  app.use(require('./routes/search'));
  app.use(require('./routes/tickets'));
  app.use(require('./routes/customers'));
  app.use(require('./routes/catalogue'));
  app.use(require('./routes/kb'));
  app.use(require('./routes/documents'));
  app.use(require('./routes/sla'));
  app.use(require('./routes/contracts'));
  app.use(require('./routes/operations'));
  app.use(require('./routes/projects'));
  app.use(require('./routes/tenders'));
  app.use(require('./routes/pipeline'));
  app.use(require('./routes/quotes'));
  app.use(require('./routes/suppliers'));
  app.use(require('./routes/lpo'));
  app.use(require('./routes/approvals'));
  app.use(require('./routes/mail'));
  app.use(require('./routes/admin'));
  app.use(require('./routes/reports'));
  app.use(require('./routes/manual'));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist, or you do not have access to it.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof tickets.UserError) {
      if (req.method !== 'GET' && req.session) {
        req.flash('error', err.userMessage);
        const ref = req.get('referer') || '';
        try { const u = new URL(ref); if (u.origin === new URL(config.baseUrl).origin) return res.redirect(u.pathname + u.search); } catch (_) { /* fall through */ }
      }
      return res.status(err.status || 400).render('error', { title: 'Cannot do that', message: err.userMessage });
    }
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).render('error', { title: 'File too large', message: 'A file is larger than the upload limit.' });
    console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
    return res.status(500).render('error', { title: 'Something went wrong', message: 'The problem has been logged. Please try again, or contact the service desk if it continues.' });
  });
  return app;
}

module.exports = createApp;
