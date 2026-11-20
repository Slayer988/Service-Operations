(function () {
  'use strict';

  // Confirm dialogs: data-confirm on a form or a button.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-confirm]');
    if (b && !window.confirm(b.dataset.confirm)) e.preventDefault();
  });

  // A header checkbox that ticks every checkbox of the class named in data-check-all.
  document.addEventListener('change', function (e) {
    var a = e.target.closest && e.target.closest('[data-check-all]');
    if (!a) return;
    document.querySelectorAll('input.' + a.dataset.checkAll).forEach(function (c) { c.checked = a.checked; });
  });

  // Side menu: collapse to icons only / expand. The choice is kept in a cookie so the server renders the right state on every page.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-nav-toggle]');
    if (!b) return;
    var root = document.documentElement;
    var collapsed = root.getAttribute('data-nav') !== 'collapsed';
    if (collapsed) root.setAttribute('data-nav', 'collapsed'); else root.removeAttribute('data-nav');
    b.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    document.cookie = 'itsm.nav=' + (collapsed ? 'collapsed' : 'open') + '; path=/; max-age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  });

  // Child selects (for example Service) only show options that belong to the selected parent (for example CSID).
  function applyFilters(form) {
    form.querySelectorAll('select[data-filter-by]').forEach(function (sel) {
      var parent = document.getElementById(sel.dataset.filterBy);
      var v = parent ? parent.value : '';
      var current = sel.value;
      var valid = false;
      sel.querySelectorAll('option[data-parent]').forEach(function (o) {
        var show = !v || o.dataset.parent === v;
        o.hidden = !show; o.disabled = !show;
        if (show && o.value === current) valid = true;
      });
      if (!valid) sel.value = '';
    });
  }

  function label(kind, item) {
    if (kind === 'csids') return item.csid;
    if (kind === 'contracts') return item.reference;
    if (kind === 'contacts') return item.name + ' <' + item.email + '>';
    return item.name;
  }

  // Staff forms: choosing a customer loads that customer's CSIDs, services, sites, contacts and contracts.
  function loadStructure(form, customerId) {
    var targets = form.querySelectorAll('[data-fill]');
    if (!customerId) { targets.forEach(function (s) { s.innerHTML = '<option value="">Choose a customer first</option>'; }); return; }
    fetch('/api/customers/' + encodeURIComponent(customerId) + '/structure', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        targets.forEach(function (sel) {
          var kind = sel.dataset.fill;
          sel.innerHTML = '';
          var blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose…'; sel.appendChild(blank);
          (data[kind] || []).forEach(function (item) {
            var o = document.createElement('option'); o.value = item.id; o.textContent = label(kind, item);
            if (kind === 'services') o.dataset.parent = item.csid_id;
            sel.appendChild(o);
          });
        });
        applyFilters(form);
      })
      .catch(function () { /* the form still works: the server validates everything */ });
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    var form = t.form;
    if (!form) return;
    if (t.dataset && t.dataset.structureSource) loadStructure(form, t.value);
    if (t.dataset && t.dataset.controls) applyFilters(form);
    if (t.id === 'status_select') {
      var box = form.querySelector('.js-resolution');
      if (box) box.hidden = t.value !== 'resolved';
    }
    if (t.id === 'contact_picker') {
      var ids = Array.prototype.filter.call(t.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
      var hidden = document.getElementById(t.dataset.target);
      if (hidden) hidden.value = ids.join(',');
    }
  });

  // Mailbox form: show only the fields that belong to the chosen provider.
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t.matches || !t.matches('[data-provider-select]')) return;
    t.form.querySelectorAll('[data-show-for]').forEach(function (el) { el.hidden = el.dataset.showFor !== t.value; });
  });

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('form').forEach(applyFilters);
    document.querySelectorAll('[data-structure-source]').forEach(function (s) { if (s.value) loadStructure(s.form, s.value); });
    var st = document.getElementById('status_select');
    if (st) { var box = st.form.querySelector('.js-resolution'); if (box) box.hidden = st.value !== 'resolved'; }
  });
  // SLA times on the ticket page count down while the page is open.
  (function () {
    var els = document.querySelectorAll('[data-sla-due]');
    if (!els.length) return;
    var span = function (ms) { var m = Math.max(0, Math.round(Math.abs(ms) / 60000)); if (m < 1) return 'under a minute'; var d = Math.floor(m / 1440); var h = Math.floor((m % 1440) / 60); var mm = m % 60; return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm' : mm + 'm'; };
    var tick = function () { els.forEach(function (el) { var left = new Date(el.getAttribute('data-sla-due')) - new Date(); el.textContent = left > 0 ? span(left) + ' left' : 'overdue by ' + span(left); }); };
    window.setInterval(tick, 30000);
  })();
  // Formatted text: a textarea marked data-rich becomes a small word-processor box (bold, italic, underline, strike-through, heading,
  // lists, quote, code, link). What is typed is kept in the textarea as the same safe mark-up the Knowledge Base uses (**bold**,
  // *italic*, ++underline++, ~~struck~~, # heading, - list, 1. list, > quote, `code`, [text](link)) and a hidden field says it is
  // formatted. The server escapes everything and turns only those marks into HTML. Without script the plain textarea still works.
  (function () {
    var areas = document.querySelectorAll('textarea[data-rich]');
    if (!areas.length || typeof document.execCommand !== 'function') return;
    var esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var SAFE = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/i;
    // ---- mark-up to HTML (for text already in the box, e.g. after a form error, and for pasted content)
    function inl(t) {
      var keep = [];
      var stash = function (h) { keep.push(h); return '\u0000' + (keep.length - 1) + '\u0000'; };
      t = t.replace(/`([^`\n]+)`/g, function (m, c) { return stash('<code>' + esc(c) + '</code>'); });
      t = t.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, function (m, label, url) { return SAFE.test(url) ? stash('<a href="' + esc(url) + '">' + esc(label) + '</a>') : m; });
      t = esc(t);
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>').replace(/\+\+([^+\n]+)\+\+/g, '<u>$1</u>').replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
      return t.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[Number(i)]; });
    }
    function toHtml(md) {
      var lines = String(md || '').replace(/\r\n?/g, '\n').split('\n'); var out = []; var i = 0; var m;
      while (i < lines.length) {
        var line = lines[i];
        if (/^```/.test(line)) { var code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; } i++; out.push('<pre>' + esc(code.join('\n')) + '</pre>'); continue; }
        if ((m = /^(#{1,3})\s+(.+)$/.exec(line))) { out.push('<h' + (m[1].length + 1) + '>' + inl(m[2]) + '</h' + (m[1].length + 1) + '>'); i++; continue; }
        if (/^>\s?/.test(line)) { var q = []; while (i < lines.length && /^>\s?/.test(lines[i])) { q.push('<div>' + (inl(lines[i].replace(/^>\s?/, '')) || '<br>') + '</div>'); i++; } out.push('<blockquote>' + q.join('') + '</blockquote>'); continue; }
        if (/^\s*[-*]\s+/.test(line)) { var ul = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { ul.push('<li>' + inl(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; } out.push('<ul>' + ul.join('') + '</ul>'); continue; }
        if (/^\s*\d+[.)]\s+/.test(line)) { var ol = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { ol.push('<li>' + inl(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; } out.push('<ol>' + ol.join('') + '</ol>'); continue; }
        out.push('<div>' + (inl(line) || '<br>') + '</div>'); i++;
      }
      return out.join('');
    }
    // ---- HTML (what is in the box) to mark-up
    var BLOCK = /^(DIV|P|H1|H2|H3|H4|H5|H6|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE|TR|SECTION|ARTICLE|HEADER|FOOTER)$/;
    function wrapMark(inner, mark) {
      return inner.split('\n').map(function (part) {
        var mm = /^(\s*)([\s\S]*?)(\s*)$/.exec(part);
        return mm[2] ? mm[1] + mark + mm[2] + mark + mm[3] : part;
      }).join('\n');
    }
    function inline(node) {
      var out = '';
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) { out += n.nodeValue.replace(/ /g, ' ').replace(/[\r\n]+/g, ' '); return; }
        if (n.nodeType !== 1) return;
        var tag = n.tagName; var inner = inline(n);
        if (tag === 'BR') out += '\n';
        else if (tag === 'B' || tag === 'STRONG') out += wrapMark(inner, '**');
        else if (tag === 'I' || tag === 'EM') out += wrapMark(inner, '*');
        else if (tag === 'U' || tag === 'INS') out += wrapMark(inner, '++');
        else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') out += wrapMark(inner, '~~');
        else if (tag === 'CODE') out += inner.trim() ? '`' + inner.replace(/`/g, "'") + '`' : inner;
        else if (tag === 'A') { var href = n.getAttribute('href') || ''; out += SAFE.test(href) && inner.trim() ? '[' + inner.replace(/[[\]\n]/g, ' ') + '](' + href + ')' : inner; }
        else if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') { /* never */ }
        else if (BLOCK.test(tag)) out += '\n' + inner + '\n';
        else out += inner;
      });
      return out;
    }
    function lines(container) {
      var out = []; var buf = '';
      var flush = function () { if (buf !== '') { buf.split('\n').forEach(function (l) { out.push(l.replace(/\s+$/, '')); }); buf = ''; } };
      container.childNodes.forEach(function (n) {
        if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCK.test(n.tagName))) {
          if (n.nodeType === 1 && n.tagName === 'BR') { buf += '\n'; return; }
          var wrap = document.createElement('span'); wrap.appendChild(n.cloneNode(true)); buf += inline(wrap); return;
        }
        if (n.nodeType !== 1) return;
        flush();
        var tag = n.tagName;
        if (/^H[1-6]$/.test(tag)) { var level = Number(tag[1]); out.push((level <= 2 ? '# ' : level === 3 ? '## ' : '### ') + inline(n).replace(/\n+/g, ' ').trim()); }
        else if (tag === 'UL' || tag === 'OL') {
          var k = 0;
          n.querySelectorAll('li').forEach(function (li) { k++; var copy = li.cloneNode(true); copy.querySelectorAll('ul,ol').forEach(function (x) { x.remove(); }); var t = inline(copy).replace(/\n+/g, ' ').trim(); if (t) out.push((tag === 'UL' ? '- ' : k + '. ') + t); });
        }
        else if (tag === 'BLOCKQUOTE') lines(n).forEach(function (l) { out.push('> ' + l); });
        else if (tag === 'PRE') { out.push('```'); n.textContent.replace(/\n$/, '').split('\n').forEach(function (l) { out.push(l); }); out.push('```'); }
        else if (tag === 'HR') out.push('---');
        else { var inner = lines(n); if (!inner.length) out.push(''); else inner.forEach(function (l) { out.push(l); }); }
      });
      flush();
      return out;
    }
    function toMarkup(el) { return lines(el).join('\n').replace(/\n{3,}/g, '\n\n').trim(); }

    var TOOLS = [
      ['bold', 'B', 'Bold (Ctrl+B)'], ['italic', 'I', 'Italic (Ctrl+I)'], ['underline', 'U', 'Underline (Ctrl+U)'], ['strikeThrough', 'S', 'Strike through'], ['|'],
      ['h', 'H', 'Heading'], ['insertUnorderedList', '• List', 'Bulleted list'], ['insertOrderedList', '1. List', 'Numbered list'], ['quote', '“ Quote', 'Quote'], ['code', '</>', 'Code or command'], ['|'],
      ['link', 'Link', 'Add a link (select the words first)'], ['clear', 'Clear', 'Remove formatting from the selection'],
    ];
    areas.forEach(function (ta) {
      var form = ta.form; if (!form) return;
      var formatName = ta.getAttribute('data-rich-format') || 'format';
      var hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = formatName; hidden.value = 'rich';
      var box = document.createElement('div'); box.className = 'rte';
      var bar = document.createElement('div'); bar.className = 'rte-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Text formatting');
      var ed = document.createElement('div'); ed.className = 'rte-area'; ed.contentEditable = 'true';
      ed.setAttribute('role', 'textbox'); ed.setAttribute('aria-multiline', 'true');
      var label = ta.id && document.querySelector('label[for="' + ta.id + '"]');
      if (label) { label.id = label.id || ta.id + '-label'; ed.setAttribute('aria-labelledby', label.id); label.addEventListener('click', function (e) { e.preventDefault(); ed.focus(); }); }
      if (ta.placeholder) ed.setAttribute('data-placeholder', ta.placeholder);
      ed.style.minHeight = (Number(ta.getAttribute('rows')) || 4) * 1.6 + 'em';
      TOOLS.forEach(function (t) {
        if (t[0] === '|') { var sep = document.createElement('span'); sep.className = 'rte-sep'; bar.appendChild(sep); return; }
        var b = document.createElement('button'); b.type = 'button'; b.className = 'rte-btn rte-' + t[0]; b.textContent = t[1]; b.title = t[2]; b.setAttribute('aria-label', t[2]); b.setAttribute('data-cmd', t[0]);
        bar.appendChild(b);
      });
      var required = ta.required; ta.required = false;
      ed.innerHTML = toHtml(ta.value);
      ta.hidden = true;
      ta.parentNode.insertBefore(box, ta); box.appendChild(bar); box.appendChild(ed); box.appendChild(ta); box.appendChild(hidden);
      var sync = function () { ta.value = toMarkup(ed); box.classList.toggle('empty', !ed.textContent.trim() && !ed.querySelector('li,hr')); };
      sync();
      var run = function (cmd) {
        ed.focus();
        try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* older browsers */ }
        if (cmd === 'h') document.execCommand('formatBlock', false, document.queryCommandValue('formatBlock').toLowerCase() === 'h3' ? 'div' : 'h3');
        else if (cmd === 'quote') document.execCommand('formatBlock', false, document.queryCommandValue('formatBlock').toLowerCase() === 'blockquote' ? 'div' : 'blockquote');
        else if (cmd === 'code') { var sel = String(window.getSelection()); document.execCommand('insertHTML', false, sel.indexOf('\n') >= 0 ? '<pre>' + esc(sel) + '</pre>' : '<code>' + (esc(sel) || '&#8203;') + '</code>&#8203;'); }
        else if (cmd === 'link') {
          var url = window.prompt('Link address (https://...)', 'https://');
          if (url && SAFE.test(url.trim())) { if (String(window.getSelection())) document.execCommand('createLink', false, url.trim()); else document.execCommand('insertHTML', false, '<a href="' + esc(url.trim()) + '">' + esc(url.trim()) + '</a>&nbsp;'); }
        } else if (cmd === 'clear') { document.execCommand('removeFormat'); document.execCommand('unlink'); document.execCommand('formatBlock', false, 'div'); }
        else document.execCommand(cmd);
        sync(); state();
      };
      bar.addEventListener('mousedown', function (e) { if (e.target.closest('.rte-btn')) e.preventDefault(); });           // keep the selection in the box
      bar.addEventListener('click', function (e) { var b = e.target.closest('.rte-btn'); if (b) run(b.getAttribute('data-cmd')); });
      var state = function () {
        ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach(function (c) {
          var b = bar.querySelector('[data-cmd="' + c + '"]'); var on = false; try { on = document.queryCommandState(c); } catch (e) { /* ignore */ }
          if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        });
      };
      ed.addEventListener('input', sync);
      ed.addEventListener('keyup', state); ed.addEventListener('mouseup', state); ed.addEventListener('focus', function () { try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (e) { /* ignore */ } });
      // pasted text keeps bold, italic, lists and links (e.g. from Word or a web page) but nothing else: it goes through the same mark-up
      ed.addEventListener('paste', function (e) {
        var cd = e.clipboardData; if (!cd) return;
        e.preventDefault();
        var html = cd.getData('text/html');
        if (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('script,style,meta,link,title,xml,o\\:p').forEach(function (x) { x.remove(); });
          document.execCommand('insertHTML', false, toHtml(toMarkup(doc.body)));
        } else document.execCommand('insertText', false, cd.getData('text/plain'));
        sync();
      });
      ed.addEventListener('drop', function (e) { e.preventDefault(); });
      form.addEventListener('submit', function (e) {
        sync();
        if (required && !ta.value.trim()) { e.preventDefault(); box.classList.add('invalid'); ed.focus(); }
      });
      form.addEventListener('reset', function () { ed.innerHTML = ''; sync(); });
    });
  })();
  // Quote lines: show each line's amount and the totals while typing (the server recalculates them when the lines are saved).
  (function () {
    var form = document.querySelector('form[data-quote-lines]');
    if (!form) return;
    var rate = Number(form.getAttribute('data-tax-rate')) || 0;
    var num = function (v, dflt) { var s = String(v || '').replace(/[,\s]/g, ''); if (s === '') return dflt; var n = Number(s); return isFinite(n) ? n : NaN; };
    var show = function (c) { return (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    function update() {
      var net = 0;
      Array.prototype.forEach.call(form.querySelectorAll('tbody tr'), function (tr) {
        var cell = tr.querySelector('[data-amount]'); if (!cell) return;
        var d = tr.querySelector('[name=description]');
        if (!d || !d.value.trim()) { cell.textContent = ''; return; }
        var q = num(tr.querySelector('[name=quantity]').value, 1); var p = num(tr.querySelector('[name=unit_price]').value, 0); var x = num(tr.querySelector('[name=discount_pct]').value, 0);
        if (isNaN(q) || isNaN(p) || isNaN(x)) { cell.textContent = '?'; return; }
        var c = Math.round(Math.round(q * 100) * Math.round(p * 100) / 100 * (1 - x / 100));
        net += c; cell.textContent = show(c);
      });
      var tax = Math.round(net * rate / 100);
      var set = function (sel, c) { var el = form.querySelector(sel); if (el) el.textContent = show(c); };
      set('[data-subtotal]', net); set('[data-tax]', tax); set('[data-total]', net + tax);
    }
    form.addEventListener('input', update);
  })();
  // The "you were signed out" notice on the sign-in page: take ?expired=1 out of the address so a refresh does not bring it back, and let it go after a while.
  (function () {
    var n = document.querySelector('[data-expired-notice]');
    if (!n) return;
    try {
      var u = new URL(window.location.href);
      if (u.searchParams.has('expired')) { u.searchParams.delete('expired'); window.history.replaceState(null, '', u.pathname + u.search); }
    } catch (e) { /* an old browser keeps the address; the server shows the notice only once anyway */ }
    window.setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 20000);
  })();
  // Idle sign-out. The page carries the idle time in seconds (data-idle on <body>). Typing, clicking, scrolling or moving the mouse counts as
  // activity and, at most once a minute, tells the server so the session stays open. A minute before the time is up a warning appears;
  // when it is up the person is signed out. The server ends an unused session on its own as well, so this only makes it visible.
  (function () {
    var secs = Number(document.body && document.body.getAttribute('data-idle'));
    if (!secs) return;
    var idleMs = secs * 1000;
    var warnMs = Math.min(60000, Math.floor(idleMs / 4));
    var pingEvery = Math.max(15000, Math.min(60000, Math.floor(idleMs / 10)));
    var KEY = 'itsm.active';
    var last = Date.now(); var lastPing = last; var lastWrite = 0; var ended = false; var bar = null; var count = null;

    function stored() { try { var v = Number(window.localStorage.getItem(KEY)); return isFinite(v) ? v : 0; } catch (e) { return 0; } }
    function lastActive() { return Math.max(last, stored()); }              // activity in another tab of this browser counts too
    function expire() { if (ended) return; ended = true; window.location.assign('/session/expired'); }
    function ping() {
      lastPing = Date.now();
      if (!window.fetch) return;
      window.fetch('/session/ping', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' })
        .then(function (r) { if (r.status === 401 || r.type === 'opaqueredirect') expire(); })
        .catch(function () { /* offline: try again at the next activity */ });
    }
    function hideBar() { if (bar) { bar.remove(); bar = null; count = null; } }
    function showBar(left) {
      if (!bar) {
        bar = document.createElement('div'); bar.className = 'idlebar'; bar.setAttribute('role', 'alertdialog'); bar.setAttribute('aria-live', 'assertive');
        count = document.createElement('span'); bar.appendChild(count);
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = 'Stay signed in';
        b.addEventListener('click', function () { mark(true); });
        bar.appendChild(b); document.body.appendChild(bar);
      }
      count.textContent = 'You will be signed out in ' + left + ' second' + (left === 1 ? '' : 's') + ' because of inactivity.';
    }
    function mark(force) {
      if (ended) return;
      var n = Date.now();
      if (n - lastActive() >= idleMs) return expire();                       // the time was already up (for example the computer slept)
      last = n;
      if (n - lastWrite > 5000) { lastWrite = n; try { window.localStorage.setItem(KEY, String(n)); } catch (e) { /* private mode */ } }
      var wasWarned = !!bar; hideBar();
      if (force || wasWarned || n - lastPing >= pingEvery) ping();
    }
    function tick() {
      if (ended) return;
      var idle = Date.now() - lastActive();
      if (idle >= idleMs) return expire();
      if (idle >= idleMs - warnMs) showBar(Math.max(1, Math.ceil((idleMs - idle) / 1000))); else hideBar();
    }
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach(function (t) { window.addEventListener(t, function () { mark(false); }, { passive: true, capture: true }); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('focus', tick);
    window.setInterval(tick, 1000);
    mark(false);
  })();
})();
