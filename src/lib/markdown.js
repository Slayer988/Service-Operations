'use strict';
// A small, safe formatter for Knowledge Base articles. Everything is escaped first; only the marks below become HTML, so an article can
// never carry a script, a style or a raw tag (the page also runs under a strict Content-Security-Policy).
//   # Heading   ## Subheading   ### Small heading     - bullet     1. numbered     > note     --- line     ``` code ```
//   **bold**  *italic*  `code`  [text](https://link)  [[KB-0012]] (another article)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SAFE_URL = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/i;

/** Inline marks on text that is NOT yet escaped. base is the path where article codes are found ('/kb' or '/portal/help'). */
function inline(text, base) {
  const keep = [];
  const stash = (html) => { keep.push(html); return `\u0000${keep.length - 1}\u0000`; };
  let s = String(text);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${esc(c)}</code>`));
  s = s.replace(/\[\[(KB-\d{4,6})\]\]/g, (_, code) => stash(`<a href="${base}/${code}">${code}</a>`));
  s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, label, url) => {
    if (!SAFE_URL.test(url)) return m;                                                   // anything else (javascript:, data:, relative) stays plain text
    const ext = /^https?:/i.test(url);
    return stash(`<a href="${esc(url)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(label)}</a>`);
  });
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

/** The article body as HTML. */
function render(body, { base = '/kb' } = {}) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map((l) => inline(l, base)).join('<br>')}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {                                                            // a block of code or commands, shown exactly as written
      flush(); const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.+)$/.exec(line))) { flush(); const lv = m[1].length + 1; out.push(`<h${lv}>${inline(m[2], base)}</h${lv}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      flush(); const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${q.map((l) => inline(l, base)).join('<br>')}</blockquote>`); continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush(); const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push(`<ul>${items.map((l) => `<li>${inline(l, base)}</li>`).join('')}</ul>`); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush(); const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      out.push(`<ol>${items.map((l) => `<li>${inline(l, base)}</li>`).join('')}</ol>`); continue;
    }
    para.push(line.trim()); i++;
  }
  flush();
  return out.join('\n');
}

/** Plain text for the search list: the start of the body without marks. */
function plain(body, n = 220) {
  const t = String(body || '').replace(/```[\s\S]*?```/g, ' ').replace(/\[\[(KB-\d+)\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*-\s+/gm, ' ').replace(/[#>*`_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

module.exports = { render, plain, inline };
