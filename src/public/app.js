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
})();
