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

  // ---------- Lot specifications: add / remove rows and quick-add labels ----------
  document.querySelectorAll('[data-specs]').forEach(function (box) {
    var rows = box.querySelector('.ax-spec-rows');
    var tools = box.querySelector('.ax-spec-tools');
    var max = Number(box.getAttribute('data-max')) || 30;
    if (tools) tools.hidden = false;
    var all = function () { return Array.prototype.slice.call(rows.querySelectorAll('.ax-spec-row')); };
    var renumber = function () {
      all().forEach(function (r, i) {
        var ins = r.querySelectorAll('input');
        ins[0].setAttribute('aria-label', 'Specification label, row ' + (i + 1));
        ins[1].setAttribute('aria-label', 'Specification value, row ' + (i + 1));
      });
      var add = box.querySelector('[data-spec-add]');
      if (add) add.disabled = all().length >= max;
    };
    var wire = function (r) {
      var b = r.querySelector('.ax-spec-remove');
      if (!b) return;
      b.hidden = false;
      b.addEventListener('click', function () {
        var list = all();
        if (list.length > 1) {
          var next = list[list.indexOf(r) + 1] || list[list.indexOf(r) - 1];
          r.remove();
          if (next) next.querySelector('input').focus();
        } else {
          r.querySelectorAll('input').forEach(function (i) { i.value = ''; });
        }
        renumber();
      });
    };
    var addRow = function (label) {
      if (all().length >= max) return null;
      var r = all()[0].cloneNode(true);
      r.classList.remove('is-bad');
      r.querySelectorAll('input').forEach(function (i) { i.value = ''; i.removeAttribute('placeholder'); i.removeAttribute('aria-invalid'); });
      rows.appendChild(r);
      wire(r);
      if (label) r.querySelector('input').value = label;
      renumber();
      return r;
    };
    all().forEach(wire);
    renumber();
    var addBtn = box.querySelector('[data-spec-add]');
    if (addBtn) addBtn.addEventListener('click', function () { var r = addRow(''); if (r) r.querySelector('input').focus(); });
    box.querySelectorAll('[data-spec-chip]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var label = chip.getAttribute('data-spec-chip');
        var existing = all().filter(function (r) { return r.querySelector('input').value.trim().toLowerCase() === label.toLowerCase(); })[0];
        var target = existing || all().filter(function (r) {
          var ins = r.querySelectorAll('input');
          return !ins[0].value.trim() && !ins[1].value.trim();
        })[0] || addRow('');
        if (!target) return;
        target.querySelector('input').value = label;
        target.querySelectorAll('input')[1].focus();
      });
    });
  });

  // ---------- File inputs: previews of chosen photos and early size / count checks ----------
  var MAX_BYTES = 8 * 1024 * 1024;
  document.querySelectorAll('input[type=file]').forEach(function (input) {
    var out = input.getAttribute('data-preview') && document.getElementById(input.getAttribute('data-preview'));
    var maxFiles = Number(input.getAttribute('data-max-files')) || 0;
    var msg = document.createElement('div');
    msg.className = 'err';
    msg.setAttribute('role', 'alert');
    var check = function () {
      var files = Array.prototype.slice.call(input.files || []);
      var problem = '';
      var big = files.filter(function (f) { return f.size > MAX_BYTES; }).map(function (f) { return '"' + f.name + '"'; });
      var accept = (input.getAttribute('accept') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var wrong = accept.length ? files.filter(function (f) { return accept.indexOf(f.type) < 0; }).map(function (f) { return '"' + f.name + '"'; }) : [];
      if (wrong.length) problem = wrong.join(', ') + (wrong.length === 1 ? ' is not' : ' are not') + ' an accepted file type. ' + (input.multiple || input.name === 'cover' || input.name === 'logo' ? 'Choose JPG, PNG or WebP photos.' : 'Choose a PDF, JPG, PNG or WebP file.');
      else if (big.length) problem = big.join(', ') + (big.length === 1 ? ' is' : ' are') + ' larger than 8 MB. Choose a smaller file.';
      else if (maxFiles && files.length > maxFiles) problem = 'You chose ' + files.length + ' photos, but only ' + maxFiles + ' more can be added to this lot.';
      input.setCustomValidity(problem);
      msg.textContent = problem;
      if (problem) input.insertAdjacentElement('afterend', msg); else if (msg.parentNode) msg.remove();
      return files;
    };
    input.addEventListener('change', function () {
      var files = check();
      if (!out) return;
      out.innerHTML = '';
      // CSP allows data: images but not blob:, so previews are read as data URLs.
      files.filter(function (f) { return /^image\/(jpeg|png|webp)$/.test(f.type) && f.size <= MAX_BYTES; }).slice(0, 12).forEach(function (f) {
        var fig = document.createElement('figure');
        fig.className = 'ax-preview' + (input.getAttribute('data-preview-kind') === 'logo' ? ' ax-preview-logo' : '');
        var img = document.createElement('img');
        img.alt = 'Preview of ' + f.name;
        var cap = document.createElement('figcaption');
        cap.textContent = f.name;
        fig.appendChild(img);
        fig.appendChild(cap);
        out.appendChild(fig);
        var reader = new FileReader();
        reader.onload = function () { img.src = reader.result; };
        reader.readAsDataURL(f);
      });
      if (files.length && out.children.length) {
        var note = document.createElement('p');
        note.className = 'hint muted small';
        note.textContent = files.length === 1 ? 'Not uploaded yet: it is saved when you submit the form.' : files.length + ' files chosen. They are uploaded when you submit the form.';
        out.appendChild(note);
      }
    });
    // The form has novalidate, so report the problem ourselves before an 8 MB upload is wasted.
    if (input.form) input.form.addEventListener('submit', function (e) {
      if (e.submitter && e.submitter.getAttribute('form') && e.submitter.getAttribute('form') !== input.form.id) return;
      if (input.validationMessage) { e.preventDefault(); input.focus(); }
    });
  });

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
