// Admin panel behaviour. Loaded only on pages that pass scripts: ['/js/admin.js'].
(function () {
  // Live auction workspace: refresh the lots and bids region every 5 seconds.
  var region = document.getElementById('live-region');
  if (region && region.getAttribute('data-live-url')) {
    var url = region.getAttribute('data-live-url');
    var busy = false;
    var timer = null;
    var applyNow = function () {
      var n = region.querySelector('[data-now]');
      if (n && window.KA && KA.setServerNow) KA.setServerNow(Number(n.getAttribute('data-now')));
    };
    applyNow();
    var refresh = function () {
      if (busy || document.hidden) return;
      busy = true;
      fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' }, cache: 'no-store' })
        .then(function (r) {
          if (r.redirected || !r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (html) {
          region.innerHTML = html;
          applyNow();
          var p = region.querySelector('[data-phase]');
          if (p && p.getAttribute('data-phase') !== 'live') {
            // The auction has finished: reload once so the page controls match.
            clearInterval(timer);
            window.location.reload();
          }
        })
        .catch(function () { /* keep the last good copy; try again on the next tick */ })
        .then(function () { busy = false; });
    };
    timer = setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  }

  // Email template editor: preview unsaved edits by posting them into the preview iframe.
  var tform = document.getElementById('template-form');
  var pform = document.getElementById('preview-form');
  if (tform && pform) {
    var t = null;
    var push = function () {
      pform.elements.subject.value = tform.elements.subject.value;
      pform.elements.body.value = tform.elements.body.value;
      pform.submit();
    };
    ['subject', 'body'].forEach(function (name) {
      tform.elements[name].addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(push, 600);
      });
    });
  }

  // <select data-show-when="value:#target">: show the target only while that value is chosen.
  document.querySelectorAll('select[data-show-when]').forEach(function (sel) {
    var parts = sel.getAttribute('data-show-when').split(':');
    var target = document.querySelector(parts[1]);
    if (!target) return;
    var sync = function () { target.classList.toggle('hide', sel.value !== parts[0]); };
    sel.addEventListener('change', sync);
    sync();
  });
})();
