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

  // Watch buttons (views/partials/watch.ejs): toggle in place with fetch; the form still works without JavaScript.
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-watch]');
    if (!f || !window.fetch) return;
    e.preventDefault();
    var id = f.getAttribute('data-watch');
    var btn = f.querySelector('button');
    var on = btn.getAttribute('aria-pressed') !== 'true';
    var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
    btn.disabled = true;
    fetch('/auctions/' + id + (on ? '/watch' : '/unwatch'), {
      method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'x-csrf-token': csrf }
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, d: d }; });
    }).then(function (res) {
      if (res.status === 401 && res.d.login) { window.location = res.d.login; return; }
      if (!res.d.ok) { KA.toast(res.d.error || 'Your watchlist was not updated. Try again.', 'bad'); return; }
      document.querySelectorAll('form[data-watch="' + id + '"]').forEach(function (g) {
        var b = g.querySelector('button');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.querySelector('.w-label').textContent = on ? b.getAttribute('data-on') : b.getAttribute('data-off');
        g.setAttribute('action', '/auctions/' + id + (on ? '/unwatch' : '/watch'));
      });
      var mins = Number(f.getAttribute('data-alert-min')) || 0;
      KA.toast(on ? 'Added to your watchlist.' + (mins > 0 ? ' We will email you ' + mins + ' minutes before bidding opens.' : '') : 'Removed from your watchlist.', 'good');
    }).catch(function () {
      KA.toast('No connection to the server. Your watchlist was not updated.', 'bad');
    }).then(function () { btn.disabled = false; });
  });

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
