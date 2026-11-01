'use strict';
// Colour themes: six (Default, the company colours, plus the original five). A theme is only a set of CSS variables (see app.css, html[data-theme=...]); the server writes the chosen
// id into <html data-theme="..."> so there is no inline style or script (strict CSP) and no flash of the wrong colours.
// People change theme only with the switch icon next to the notification bell.
const THEMES = [
  { id: 'default',  label: 'Default',        text: 'Company colours: deep navy, teal and mint, with red headings.' },
  { id: 'green',    label: 'Service Green',  text: 'Fresh green on white.' },
  { id: 'sunset',   label: 'Sunset Orange',  text: 'Warm orange.' },
  { id: 'auto',     label: 'Match Device',   text: 'Green by day, Midnight Dark when your device is in dark mode.' },
  { id: 'ocean',    label: 'Ocean Blue',     text: 'Calm blue.' },
  { id: 'midnight', label: 'Midnight Dark',  text: 'Dark background, easy on the eyes at night.' },
];
const IDS = THEMES.map((t) => t.id);
const DEFAULT = 'default';

const valid = (id) => (typeof id === 'string' && IDS.includes(id) ? id : null);

/** The theme to render: the person's own choice (stored for them, or remembered in this browser when signed out), else Default. */
const resolve = (own) => valid(own) || DEFAULT;

/** A same-site path to return to after switching theme (never an absolute URL or a protocol-relative one). */
function safeBack(p) { const s = String(p || ''); return /^\/(?![/\\])[^\r\n]*$/.test(s) && s.length < 500 ? s : '/'; }

module.exports = { THEMES, IDS, DEFAULT, valid, resolve, safeBack };
