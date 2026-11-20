'use strict';
// Colours for the documents a person downloads (PDF and Excel), taken from the theme they are using. Documents are printed on white
// paper, so each theme gives a strong colour for the title bar and table headings, a darker one for headings and totals, a pale one
// for alternate rows, and a muted grey for labels. Match Device uses the daytime colours (paper is always light).
const themes = require('./themes');

const PALETTES = {
  // the company colours: deep navy bar, teal headings, mint rows
  default: { bar: '#0b192c', head: '#0b192c', dark: '#02837b', light: '#e9f6f3', grey: '#5a6b78', rule: '#02837b' },
  green: { bar: '#0b7a1f', head: '#0b7a1f', dark: '#075f17', light: '#f0f8f1', grey: '#5d6b61', rule: '#0b7a1f' },
  auto: { bar: '#0b7a1f', head: '#0b7a1f', dark: '#075f17', light: '#f0f8f1', grey: '#5d6b61', rule: '#0b7a1f' },
  ocean: { bar: '#0b66b8', head: '#0b66b8', dark: '#084a87', light: '#eff6fd', grey: '#5a6b7a', rule: '#0b66b8' },
  sunset: { bar: '#c2570c', head: '#c2570c', dark: '#8f3f06', light: '#fff6ec', grey: '#7a6a58', rule: '#c2570c' },
};

/** The palette for a theme id, or for a signed-in person (their chosen theme, else Default). */
function palette(themeOrUser) {
  const id = themeOrUser && typeof themeOrUser === 'object' ? themes.resolve(themeOrUser.theme) : themes.resolve(themeOrUser);
  return PALETTES[id] || PALETTES.default;
}

/** "#0b7a1f" -> "0.043 0.478 0.122" (PDF colour operands). */
const pdfRgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
/** The colour a recoloured logo takes in each theme: dark parts become this colour, white stays white. */
const logoTint = (themeId) => (PALETTES[themeId] || PALETTES.default).dark;
/** feColorMatrix values that do the same on screen: grey from the luminance, then mixed from the tint (dark) to white (light). */
function logoMatrix(hex) {
  const t = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const row = (c) => { const k = 1 - c; return [0.2126 * k, 0.7152 * k, 0.0722 * k, 0, c].map((n) => +n.toFixed(4)).join(' '); };
  return `${row(t[0])}  ${row(t[1])}  ${row(t[2])}  0 0 0 1 0`;
}
/** "#0b7a1f" -> "FF0B7A1F" (Excel ARGB). */
const argb = (hex) => `FF${hex.slice(1).toUpperCase()}`;

module.exports = { PALETTES, palette, pdfRgb, argb, logoTint, logoMatrix };
