// Shared behaviour for every page. No inline scripts are allowed by the site's CSP, so pages
// opt in with data attributes.
(function () {
  // data-toggle="#selector": toggles the "open" class on the target.
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle]');
    if (t) { var el = document.querySelector(t.getAttribute('data-toggle')); if (el) el.classList.toggle('open'); }
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
})();
