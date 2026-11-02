'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('../../src/lib/session');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

test('idle time: 10 minutes by default, bad values fall back, limits are kept', () => {
  assert.equal(session.idleMinutes(undefined), 10);
  assert.equal(session.idleMinutes(''), 10);
  assert.equal(session.idleMinutes('abc'), 10);
  assert.equal(session.idleMinutes('15'), 15);
  assert.equal(session.idleMinutes('0'), 1);
  assert.equal(session.idleMinutes('-5'), 1);
  assert.equal(session.idleMinutes('100000'), 480);
  if (process.env.SESSION_IDLE_MINUTES === undefined) assert.equal(require('../../src/config').sessionIdleMinutes, 10);
});

test('the "was signed in" marker is read from the cookie header', () => {
  assert.equal(session.hasMarker('itsm.in=1'), true);
  assert.equal(session.hasMarker('a=b; itsm.in=1; itsm.sid=s%3Aabc'), true);
  assert.equal(session.hasMarker('itsm.sid=s%3Aabc'), false);
  assert.equal(session.hasMarker('xitsm.in=1'), false);
  assert.equal(session.hasMarker('itsm.in=10'), false);
  assert.equal(session.hasMarker(undefined), false);
});

test('sign-in redirects remember the page, and say when the session ended', () => {
  assert.equal(session.loginUrl('/tickets?type=incident', false), '/login?next=%2Ftickets%3Ftype%3Dincident');
  assert.equal(session.loginUrl('/tickets', true), '/login?expired=1&next=%2Ftickets');
  assert.equal(session.loginUrl('', false), '/login?next=%2F');
});

test('idle sign-out is wired: session cookie, page attribute, script, warning style, settings, docs', () => {
  assert.match(read('src/app.js'), /maxAge: config\.sessionIdleMinutes \* 60 \* 1000/);
  assert.match(read('src/app.js'), /rolling: true/);
  assert.match(read('src/views/partials/header.ejs'), /data-idle=/);
  const js = read('src/public/app.js');
  for (const w of ['/session/ping', '/session/expired', 'data-idle', 'Stay signed in', 'sessionStorage|localStorage']) assert.match(js, new RegExp(w));
  assert.ok(!/innerHTML/.test(js.slice(js.indexOf('Idle sign-out'))), 'the warning is built without innerHTML');
  assert.match(read('src/public/app.css'), /\.idlebar\{/);
  // deploy/ is only beside the installer, not in the installed copy, so these two checks run where the file exists
  const example = path.join(__dirname, '../../deploy/itsm.env.example');
  const envText = fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '';
  if (envText) assert.match(envText, /^SESSION_IDLE_MINUTES=10$/m);
  assert.ok(!/SESSION_IDLE_HOURS/.test(read('src/config.js') + read('src/app.js') + envText), 'the old hours setting is gone');
  assert.match(read('src/views/auth/login.ejs'), /signed out because you were inactive/);
});
