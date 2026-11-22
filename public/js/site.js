// Shared behaviour for every page. No inline scripts are allowed by the site's CSP, so pages
// opt in with data attributes.
(function () {
  // data-toggle="#selector": toggles the "open" class on the target.
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle]');
    if (t) {
      var el = document.querySelector(t.getAttribute('data-toggle'));
      if (el) { var open = el.classList.toggle('open'); t.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    }
    // Close an open account menu when clicking elsewhere.
    document.querySelectorAll('details.acct-menu[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
    // data-confirm="question": asks before submitting a form or following a link (uses an in-page prompt).
    var c = e.target.closest('[data-confirm]');
    if (c && !c.dataset.confirmed) {
      e.preventDefault();
      if (window.confirm(c.getAttribute('data-confirm'))) {
        c.dataset.confirmed = '1';
        if (c.tagName === 'A') window.location = c.href; else if (c.form) c.form.requestSubmit ? c.form.requestSubmit(c) : c.form.submit();
      }
    }
  });

  // Countdowns: <span data-countdown="<epoch ms>" data-done="Closed">. The server clock is the
  // reference: <body data-now> or KA.setServerNow() keeps the offset.
  var offset = 0;
  window.KA = window.KA || {};
  KA.setServerNow = function (ms) { offset = ms - Date.now(); };
  KA.now = function () { return Date.now() + offset; };
  KA.fmtLeft = function (ms) {
    if (ms <= 0) return null;
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    if (d > 0) return d + 'd ' + h + 'h';
    return (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(x);
  };
  KA.toast = function (text, kind) {
    var box = document.getElementById('toasts'); if (!box) return;
    var el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.textContent = text;
    box.appendChild(el); setTimeout(function () { el.remove(); }, 6000);
  };
  KA.inr = function (n) { return n === null || n === undefined ? '' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
  var nowAttr = document.querySelector('[data-server-now]');
  if (nowAttr) KA.setServerNow(Number(nowAttr.getAttribute('data-server-now')));
  function tick() {
    document.querySelectorAll('[data-countdown]').forEach(function (el) {
      var left = Number(el.getAttribute('data-countdown')) - KA.now();
      var txt = KA.fmtLeft(left);
      el.textContent = txt === null ? (el.getAttribute('data-done') || 'Closed') : txt;
      el.classList.toggle('urgent', txt !== null && left < 120000);
    });
  }
  tick(); setInterval(tick, 1000);

  // Escape closes the account menu and the mobile menu.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('details.acct-menu[open]').forEach(function (d) { d.removeAttribute('open'); var s = d.querySelector('summary'); if (s) s.focus(); });
    var hdr = document.querySelector('.site-header.open');
    if (hdr) { hdr.classList.remove('open'); var b = hdr.querySelector('.menu-toggle'); if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); } }
  });

  // IST date and time in the utility bar, from the server clock.
  var clock = document.querySelector('[data-ist-clock]');
  if (clock) {
    var wFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
    var dFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    var tFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
    var dEl = clock.querySelector('.u-date'), tEl = clock.querySelector('.u-time');
    var paint = function () {
      var now = new Date(KA.now());
      if (dEl) dEl.textContent = wFmt.format(now) + ', ' + dFmt.format(now) + ',';
      if (tEl) tEl.textContent = tFmt.format(now).toLowerCase();
    };
    paint(); setInterval(paint, 15000);
  }

  // In-page section links (auction page): mark the last section whose top has scrolled past the bar.
  var spy = Array.prototype.slice.call(document.querySelectorAll('.subnav a[href^="#"]'));
  if (spy.length) {
    var spyT = spy.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
    var spyRun = function () {
      var cur = 0;
      spyT.forEach(function (t, i) { if (t && t.getBoundingClientRect().top < 170) cur = i; });
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) cur = spy.length - 1;
      if (window.scrollY < 40) cur = 0;
      spy.forEach(function (a, i) { a.classList.toggle('active', i === cur); });
    };
    window.addEventListener('scroll', spyRun, { passive: true }); spyRun();
  }
})();
