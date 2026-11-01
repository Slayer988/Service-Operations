'use strict';
// Development check: compiles every EJS template's scriptlets to catch syntax errors without the ejs package.
// (The real engine is `ejs`; this only verifies the embedded JavaScript parses.)
const fs = require('fs');
const path = require('path');
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); }
let bad = 0;
for (const f of walk(path.join(__dirname, '..', 'src', 'views')).filter((x) => x.endsWith('.ejs'))) {
  const src = fs.readFileSync(f, 'utf8');
  let code = '';
  const re = /<%([=\-#_]?)([\s\S]*?)-?%>/g;
  let m; let last = 0;
  while ((m = re.exec(src))) {
    code += `__out += ${JSON.stringify(src.slice(last, m.index))};\n`;
    last = re.lastIndex;
    if (m[1] === '=' || m[1] === '-') code += `__out += (${m[2].trim()});\n`;
    else if (m[1] !== '#') code += `${m[2]}\n`;
  }
  code += `__out += ${JSON.stringify(src.slice(last))};`;
  try { new Function('locals', `var __out='';with(locals){${code}}return __out;`); }
  catch (e) { bad++; console.error(`SYNTAX ${path.relative(process.cwd(), f)}: ${e.message}`); }
  if (/\sstyle\s*=/.test(src)) { bad++; console.error(`INLINE STYLE (blocked by CSP) in ${path.relative(process.cwd(), f)}`); }
  if (/<script[^>]*>[^<]/.test(src.replace(/<%[\s\S]*?%>/g, 'X').replace(/<script[^>]*src=[^>]*><\/script>/g, ''))) { bad++; console.error(`INLINE SCRIPT (blocked by CSP) in ${path.relative(process.cwd(), f)}`); }
  if (/\son[a-z]+\s*=/.test(src.replace(/<%[\s\S]*?%>/g, ''))) { bad++; console.error(`INLINE HANDLER (blocked by CSP) in ${path.relative(process.cwd(), f)}`); }
}
console.log(bad ? `${bad} problem(s)` : 'all views parse');
process.exit(bad ? 1 : 0);
