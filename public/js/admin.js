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
      else if (maxFiles && files.length > maxFiles) problem = 'You chose ' + files.length + ' photos, but only ' + maxFiles + ' more can be added to this ' + (input.getAttribute('data-max-what') || 'lot') + '.';
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

  // ---------- Tick-all checkbox: <input type=checkbox data-select-all="fieldName"> ----------
  document.querySelectorAll('input[data-select-all]').forEach(function (all) {
    var name = all.getAttribute('data-select-all');
    var scope = all.form || all.closest('form') || all.closest('table') || document;
    var boxes = function () {
      var formId = all.getAttribute('form');
      var sel = 'input[type=checkbox][name="' + name + '"]';
      return Array.prototype.slice.call((formId ? document : scope).querySelectorAll(sel)).filter(function (b) {
        return b !== all && (!formId || b.getAttribute('form') === formId);
      });
    };
    all.hidden = false;
    var sync = function () {
      var list = boxes();
      var on = list.filter(function (b) { return b.checked; }).length;
      all.checked = list.length > 0 && on === list.length;
      all.indeterminate = on > 0 && on < list.length;
    };
    all.addEventListener('change', function () { boxes().forEach(function (b) { b.checked = all.checked; }); sync(); });
    boxes().forEach(function (b) { b.addEventListener('change', sync); });
    sync();
  });

  // ---------- Copy buttons: data-copy="text" or data-copy-from="elementId" ----------
  var copyText = function (text, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { done(false); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    done(ok);
  };
  document.querySelectorAll('[data-copy], [data-copy-from]').forEach(function (btn) {
    btn.hidden = false;
    var label = btn.textContent;
    btn.addEventListener('click', function () {
      var src = btn.getAttribute('data-copy-from');
      var el = src && document.getElementById(src);
      var text = el ? el.value || el.textContent : btn.getAttribute('data-copy');
      copyText(text, function (ok) {
        btn.textContent = ok === false ? 'Select and copy' : 'Copied';
        if (ok === false && el && el.select) el.select();
        setTimeout(function () { btn.textContent = label; }, 1800);
      });
    });
  });

  // ---------- Helpers for the live previews ----------
  var TZ = 'Asia/Kolkata';
  var nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  var nf3 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
  var money = function (v) {
    var s = String(v || '').replace(/[,\s₹]/g, '');
    return /^\d+(\.\d{1,2})?$/.test(s) && Number(s) > 0 ? Number(s) : null;
  };
  var inr = function (n) { return '₹' + nf.format(n); };
  var dtParts = function (d, opts) {
    var o = {};
    new Intl.DateTimeFormat('en-IN', Object.assign({ timeZone: TZ }, opts)).formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return o;
  };
  var timeText = function (d) { return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d).toLowerCase(); };
  var dayKey = function (d) { var p = dtParts(d, { year: 'numeric', month: '2-digit', day: '2-digit' }); return p.year + p.month + p.day; };
  // datetime-local values are typed in IST.
  var parseIST = function (v) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v || '')) return null;
    var d = new Date(v.slice(0, 16) + ':00+05:30');
    return isNaN(d) ? null : d;
  };
  var show = function (el, on) { if (el) el.hidden = !on; };
  var readFirstImage = function (input, cb) {
    var f = input && input.files && Array.prototype.slice.call(input.files).filter(function (x) { return /^image\/(jpeg|png|webp)$/.test(x.type) && x.size <= MAX_BYTES; })[0];
    if (!f) { cb(null); return; }
    var r = new FileReader();
    r.onload = function () { cb(r.result); };
    r.readAsDataURL(f);
  };

  // ---------- Auction form: who can see it ----------
  var visRadios = document.querySelectorAll('input[name=visibility]');
  if (visRadios.length) {
    var pick = document.querySelector('[data-show-for="restricted"]');
    var nobody = document.querySelector('[data-nobody]');
    var syncVis = function () {
      var restricted = (document.querySelector('input[name=visibility]:checked') || {}).value === 'restricted';
      if (pick) pick.classList.toggle('hide', !restricted);
      if (nobody) {
        var ticked = document.querySelectorAll('input[name=group_ids]:checked').length;
        var invites = Number(nobody.getAttribute('data-invites')) || 0;
        nobody.hidden = !(restricted && !ticked && !invites);
      }
    };
    visRadios.forEach(function (r) { r.addEventListener('change', syncVis); });
    document.querySelectorAll('input[name=group_ids]').forEach(function (c) { c.addEventListener('change', syncVis); });
    syncVis();
  }

  // ---------- Auction form: live card preview ----------
  var card = document.querySelector('[data-card-preview]');
  if (card) {
    var form = document.getElementById('auction-form');
    var pv = function (k) { return card.querySelector('[data-pv="' + k + '"]'); };
    var val = function (id) { var el = form.elements[id]; return el ? String(el.value || '').trim() : ''; };
    var uploaded = null; // data URL of the first chosen photo
    var render = function () {
      pv('title').textContent = val('title') || 'Auction title';
      var cat = val('category');
      pv('category').textContent = cat;
      show(pv('category-row'), !!cat);
      var sel = form.elements.seller_id;
      var seller = sel && sel.value ? sel.options[sel.selectedIndex].text.replace(/ \(inactive\)$/, '') : '';
      pv('seller').textContent = seller;
      show(pv('seller-row'), !!seller);
      pv('location').textContent = val('location');
      show(pv('location-row'), !!val('location'));

      var s = form.elements.starts_at ? parseIST(val('starts_at')) : (card.getAttribute('data-starts') ? new Date(card.getAttribute('data-starts')) : null);
      var e = form.elements.ends_at ? parseIST(val('ends_at')) : (card.getAttribute('data-ends') ? new Date(card.getAttribute('data-ends')) : null);
      var when = 'Set the bidding window';
      if (s) {
        var p = dtParts(s, { weekday: 'short', day: 'numeric', month: 'short' });
        when = p.weekday + ' ' + p.day + ' ' + p.month + ', ' + timeText(s);
        if (e && e > s) {
          if (dayKey(s) === dayKey(e)) when += ' to ' + timeText(e);
          else { var q = dtParts(e, { day: 'numeric', month: 'short' }); when += ' to ' + q.day + ' ' + q.month + ', ' + timeText(e); }
        }
      }
      pv('when').textContent = when;
      var lots = Number(card.getAttribute('data-lots')) || 0;
      pv('lots').textContent = lots ? lots + (lots === 1 ? ' lot' : ' lots') : 'Lots are added after saving';

      var now = Date.now();
      var phase = !s || now < s.getTime() ? 'upcoming' : (e && now < e.getTime() ? 'live' : 'closed');
      var tagEl = pv('phase');
      tagEl.className = 'tag' + (phase === 'live' ? ' tag-live' : phase === 'upcoming' ? ' tag-upcoming' : '');
      tagEl.textContent = phase === 'live' ? 'Live' : phase === 'upcoming' ? 'Upcoming' : 'Closed';
      var status = val('status');
      if (status === 'draft') { tagEl.className = 'tag'; tagEl.textContent = 'Draft'; }
      if (status === 'cancelled') { tagEl.className = 'tag tag-bad'; tagEl.textContent = 'Cancelled'; }
      var restricted = (form.querySelector('input[name=visibility]:checked') || {}).value === 'restricted';
      show(pv('restricted'), restricted);
      pv('foot-label').textContent = phase === 'live' ? 'Closes' : phase === 'upcoming' ? 'Starts' : 'Closed on';
      var footDate = phase === 'upcoming' ? s : e;
      pv('foot-value').textContent = footDate ? (function () { var r = dtParts(footDate, { day: 'numeric', month: 'short' }); return r.day + ' ' + r.month + ', ' + timeText(footDate); })() : '';
      pv('foot-btn').textContent = phase === 'live' ? 'Bid now' : phase === 'upcoming' ? 'View lots' : 'View results';
      pv('foot-btn').className = 'btn btn-sm ' + (phase === 'live' ? 'btn-accent' : 'btn-quiet');
      pv('note').textContent = (status === 'draft' ? 'Draft: bidders cannot see it until it is published. ' : '')
        + (restricted ? 'Restricted: only its groups and invited bidders see this card. ' : '') + 'Times are IST.';

      var src = uploaded || card.getAttribute('data-cover');
      var img = pv('img');
      if (src) { if (img.getAttribute('src') !== src) img.src = src; img.hidden = false; show(pv('ph'), false); } else { img.hidden = true; show(pv('ph'), true); }
    };
    var timer = null;
    var later = function () { clearTimeout(timer); timer = setTimeout(render, 120); };
    form.addEventListener('input', later);
    form.addEventListener('change', later);
    var files = form.elements.images;
    if (files) files.addEventListener('change', function () {
      readFirstImage(files, function (url) {
        // A new photo only becomes the cover when the auction has none yet.
        uploaded = card.getAttribute('data-cover') ? null : url;
        render();
      });
    });
    render();
  }

  // ---------- Lot form: live preview ----------
  var lotPv = document.querySelector('[data-lot-preview]');
  if (lotPv) {
    var lf = document.getElementById('lot-form');
    var lp = function (k) { return lotPv.querySelector('[data-pv="' + k + '"]'); };
    var lv = function (id) { var el = lf.elements[id]; return el && el.value !== undefined ? String(el.value).trim() : ''; };
    var lotUploaded = null;
    var renderLot = function () {
      lp('lot_no').textContent = lv('lot_no') || '';
      lp('title').textContent = lv('title') || 'Material';
      var unit = lv('unit') || 'unit';
      lp('unit').textContent = unit;
      var qRaw = lv('quantity').replace(/[,\s]/g, '');
      lp('qty').textContent = /^\d+(\.\d{1,3})?$/.test(qRaw) && Number(qRaw) > 0 ? nf3.format(Number(qRaw)) + ' ' + unit : 'Quantity not set';
      var start = money(lv('start_price'));
      var inc = money(lv('increment'));
      lp('start').textContent = start ? inr(start) + ' / ' + unit : 'Not set';
      lp('increment').textContent = inc ? inr(inc) : 'Not set';
      var gps = [];
      lf.querySelectorAll('input[data-gp-name]').forEach(function (i) {
        var n = money(i.value);
        if (n) gps.push(i.getAttribute('data-gp-name') + ' ' + inr(n));
      });
      var gpEl = lp('gp');
      gpEl.textContent = gps.length ? 'Group start prices: ' + gps.join('; ') : '';
      gpEl.hidden = !gps.length;
      var tbody = lp('specs');
      tbody.innerHTML = '';
      var labels = lf.querySelectorAll('input[name=spec_label]');
      var values = lf.querySelectorAll('input[name=spec_value]');
      var shown = 0;
      for (var i = 0; i < labels.length && shown < 8; i++) {
        var a = labels[i].value.trim();
        var b = values[i] ? values[i].value.trim() : '';
        if (!a || !b) continue;
        var tr = document.createElement('tr');
        var th = document.createElement('th');
        th.scope = 'row';
        th.textContent = a;
        var td = document.createElement('td');
        td.textContent = b;
        tr.appendChild(th);
        tr.appendChild(td);
        tbody.appendChild(tr);
        shown++;
      }
      lp('specs-table').hidden = !shown;
      var src = lotUploaded || lotPv.getAttribute('data-cover');
      var img = lp('img');
      if (src) { if (img.getAttribute('src') !== src) img.src = src; img.hidden = false; show(lp('ph'), false); } else { img.hidden = true; show(lp('ph'), true); }
    };
    var lt = null;
    var lotLater = function () { clearTimeout(lt); lt = setTimeout(renderLot, 120); };
    lf.addEventListener('input', lotLater);
    lf.addEventListener('change', lotLater);
    lf.addEventListener('click', function (e) { if (e.target.closest('.ax-spec-remove, [data-spec-chip], [data-spec-add]')) lotLater(); });
    var lfiles = lf.elements.images;
    if (lfiles) lfiles.addEventListener('change', function () {
      readFirstImage(lfiles, function (url) { lotUploaded = lotPv.getAttribute('data-cover') ? null : url; renderLot(); });
    });
    renderLot();
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
