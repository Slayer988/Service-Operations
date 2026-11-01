'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const themes = require('../../src/lib/themes');

const css = fs.readFileSync(path.join(__dirname, '../../src/public/app.css'), 'utf8');

test('there are exactly six themes, Default first, then the five agreed ones', () => {
  assert.deepEqual(themes.THEMES.map((t) => t.label), ['Default', 'Service Green', 'Sunset Orange', 'Match Device', 'Ocean Blue', 'Midnight Dark']);
  assert.deepEqual(themes.IDS, ['default', 'green', 'sunset', 'auto', 'ocean', 'midnight']);
});

test('theme ids are validated and anything else falls back to Default', () => {
  assert.equal(themes.valid('ocean'), 'ocean');
  for (const bad of ['', 'neon', 'violet', 'slate', null, undefined, 'OCEAN', 'ocean"><script>', 42]) assert.equal(themes.valid(bad), null);
  assert.equal(themes.resolve('sunset'), 'sunset');
  assert.equal(themes.resolve('violet'), 'default');
  assert.equal(themes.resolve(undefined), 'default');
  assert.equal(themes.resolve('green'), 'green');
});

test('every theme has a label, a description, a swatch and a CSS block (green is the base); removed themes are gone', () => {
  const dir = path.join(__dirname, '../../migrations'); const sql = fs.readFileSync(path.join(dir, '010_default_theme.sql'), 'utf8');
  for (const t of themes.THEMES) {
    assert.ok(t.label && t.text, t.id);
    if (t.id !== 'green') assert.ok(css.includes(`html[data-theme="${t.id}"]`), `no CSS for ${t.id}`);
    assert.ok(css.includes(`.t-${t.id}{`), `no swatch for ${t.id}`);
    assert.ok(sql.includes(`'${t.id}'`), `${t.id} is not allowed by the database`);
  }
  for (const gone of ['violet', 'slate']) { assert.ok(!css.includes(`html[data-theme="${gone}"]`), gone); assert.ok(!css.includes(`.t-${gone}{`), gone); }
});

test('every theme block only sets variables that exist in :root, and the stylesheet has no fixed colours outside the variable blocks', () => {
  const vars = (sel) => { const m = css.indexOf(sel); const body = css.slice(css.indexOf('{', m) + 1, css.indexOf('}', m)); return new Set([...body.matchAll(/--([a-z0-9-]+):/g)].map((x) => x[1])); };
  const base = vars(':root{');
  for (const id of ['default', 'ocean', 'sunset', 'midnight']) for (const v of vars(`html[data-theme="${id}"]`)) assert.ok(base.has(v), `--${v} in ${id}`);
  const rules = css.slice(css.indexOf('*{box-sizing')).split('/* ---------------------------------------------------------------- themes')[0];
  assert.deepEqual([...rules.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map((x) => x[0]), []);
});

test('the return address after switching theme stays on this site', () => {
  assert.equal(themes.safeBack('/tickets?type=incident'), '/tickets?type=incident');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', 'javascript:alert(1)', '', undefined, '/a\r\nSet-Cookie: x=1']) assert.equal(themes.safeBack(bad), '/');
});

test('the menu can be collapsed to icons, and error codes have colours', () => {
  assert.ok(css.includes('html[data-nav="collapsed"] .shell'));
  for (const k of ['warn', 'deny', 'missing', 'fault']) assert.ok(css.includes(`.errc.${k}{`), k);
});
