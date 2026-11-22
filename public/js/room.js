// Bidding room, shared by the auction page (one row per lot) and the lot page (one bid panel).
// The server renders every lot; this script keeps them current from GET /auctions/:id/state
// (on socket "lot" events, every 15 s and on reconnect) and submits bids with fetch.
//
// Markup contract:
//   [data-room data-auction data-phase data-starts data-user data-can-bid]   the room root
//     [data-lot data-status data-unit data-ends (data-increment)]            one per lot shown
//       .js-high > div      highest bid and bid count
//       .js-close > div     countdown or closing time
//       .js-standing        the bidder's standing
//       .js-action          bid form (.bid-form, .bid-confirm, .bid-msg) or the result tag
//       [data-step=N]       optional quick-step buttons (current highest + N increments)
//       .js-live-tag        optional Live / Closed badge
//       .js-abnote          optional "Auto-bid up to" note (auction page rows), .js-abmax inside
//       .js-autobid         optional auto-bid box (lot page): .js-ab-status, .ab-form, .ab-confirm, .ab-stop, .ab-msg
//   data-state-url on the root overrides the state URL (admin preview with ?as_group=).
//   #rb-clock, #rb-conn, #rb-conn-text, #rb-open, #rb-leading, #rb-last, #rb-phase, [data-last-close]   optional
(function () {
  var root = document.querySelector('[data-room]');
  if (!root) return;

  var auctionId = root.getAttribute('data-auction');
  var stateUrl = root.getAttribute('data-state-url') || '/auctions/' + auctionId + '/state';
  var phase = root.getAttribute('data-phase');
  var startsAt = Number(root.getAttribute('data-starts'));
  var signedIn = root.getAttribute('data-user') === '1';
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var units = {};
  root.querySelectorAll('[data-lot][data-status]').forEach(function (u) { units[u.getAttribute('data-lot')] = u; });

  var el = function (id) { return document.getElementById(id); };
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var round2 = function (n) { return Math.round(n * 100) / 100; };
  var timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
  var clockFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  var dtFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  var fmtTime = function (ms) { return timeFmt.format(new Date(ms)).toLowerCase(); };
  var fmtDT = function (ms) { return dtFmt.format(new Date(ms)) + ', ' + fmtTime(ms); };
  var unitOf = function (node) { return node.closest('[data-lot][data-status]'); };

  // Same wording as resultFor() in views/site/auction.ejs and lot.ejs.
  function resultFor(l) {
    if (l.result === 'awarded') return l.won ? ['Awarded to you', 'tag-ok'] : ['Sold', ''];
    if (l.result === 'pending') return ['Awaiting seller decision', 'tag-warn'];
    if (l.result === 'rejected') return ['Not sold', ''];
    if (l.result === 'no_bids') return ['No bids', ''];
    return ['Closed', ''];
  }

  /* ---------- Clock and connection indicator ---------- */
  function tickClock() {
    var c = el('rb-clock');
    if (c) c.textContent = clockFmt.format(new Date(KA.now())).toLowerCase();
  }
  tickClock(); setInterval(tickClock, 1000);

  function setConn(on) {
    var c = el('rb-conn'); if (!c) return;
    c.classList.toggle('on', on);
    if (el('rb-conn-text')) el('rb-conn-text').textContent = on ? 'Live updates on' : 'Reconnecting';
  }

  /* ---------- Applying state ---------- */
  function patchUnit(u, l) {
    var unit = u.getAttribute('data-unit');
    var wasOpen = u.getAttribute('data-status') === 'open';
    var sig = [l.status, l.result, l.highest, l.bids, l.endsAt, l.leading, l.myBid, l.myMax].join('|');
    var changed = u.getAttribute('data-sig') !== null && u.getAttribute('data-sig') !== sig;
    u.setAttribute('data-sig', sig);
    u.setAttribute('data-status', l.status);
    u.setAttribute('data-ends', l.endsAt);

    // Highest bid and bid count
    var high = u.querySelector('.js-high > div');
    if (high) {
      var top = l.highest !== null && l.highest !== undefined
        ? '<span class="price">' + esc(KA.inr(l.highest)) + '</span>'
        : '<span class="muted">' + (l.bids > 0 ? 'Hidden' : 'No bids yet') + '</span>';
      high.innerHTML = top + '<span class="sub">' + plural(l.bids, 'bid') + '</span>';
    }

    // Closing time
    var close = u.querySelector('.js-close > div');
    if (close) {
      if (l.status === 'open' && phase === 'live') {
        var cd = close.querySelector('.countdown');
        if (!cd) {
          close.innerHTML = '<span class="countdown" data-done="Closing"></span><span class="sub"></span>';
          cd = close.querySelector('.countdown');
        }
        cd.setAttribute('data-countdown', l.endsAt);
        var sub = close.querySelector('.sub');
        if (sub) sub.textContent = 'at ' + fmtTime(l.endsAt);
      } else if (l.status === 'closed' && wasOpen) {
        close.innerHTML = '<span>Closed</span><span class="sub">' + esc(fmtDT(l.endsAt)) + '</span>';
      }
    }
    var liveTag = u.querySelector('.js-live-tag');
    if (liveTag && l.status === 'closed') { liveTag.className = 'tag js-live-tag tag-dark'; liveTag.textContent = 'Closed'; }

    // Standing
    var st = u.querySelector('.js-standing');
    var mine = signedIn && l.myBid !== null && l.myBid !== undefined;
    if (st) {
      st.className = 'js-standing standing' + (!mine ? '' : l.status !== 'open' ? ' done' : l.leading ? ' lead' : ' out');
      st.textContent = !mine ? ''
        : l.status !== 'open' ? 'Your highest bid ' + KA.inr(l.myBid)
        : l.leading ? 'Leading with ' + KA.inr(l.myBid)
        : 'Outbid. Your bid ' + KA.inr(l.myBid);
    }
    u.classList.toggle('leading', mine && (l.status === 'open' ? l.leading : !!l.won));
    u.classList.toggle('outbid', mine && l.status === 'open' && !l.leading);

    // Bid form or result
    var action = u.querySelector('.js-action');
    if (action) {
      if (l.status !== 'open') {
        if (!action.querySelector('.tag') || changed) {
          var r = resultFor(l);
          action.innerHTML = '<span class="tag ' + r[1] + '">' + esc(r[0]) + '</span>';
        }
      } else {
        var form = action.querySelector('.bid-form');
        if (form) {
          var input = form.querySelector('input[name=amount]');
          var msg = action.querySelector('.bid-msg');
          msg.setAttribute('data-min', l.minBid);
          // Never overwrite what the bidder is typing; otherwise keep the box at the new minimum.
          if (document.activeElement !== input && action.querySelector('.bid-confirm').classList.contains('hide')) {
            var typed = Number(input.value);
            if (!input.getAttribute('data-dirty') || !(typed >= l.minBid)) {
              input.value = l.minBid;
              input.removeAttribute('data-dirty');
            }
          }
          if (!msg.getAttribute('data-hold')) setMin(msg, unit);
        }
      }
    }
    patchAuto(u, l);
    if (changed) {
      u.classList.remove('flash'); void u.offsetWidth; u.classList.add('flash');
    }
  }

  // Auto-bid note (auction page) and auto-bid box (lot page) from state.myMax.
  function patchAuto(u, l) {
    var mine = signedIn && l.status === 'open' && l.myMax !== null && l.myMax !== undefined;
    var passed = mine && !l.leading && l.myMax < l.minBid;
    var note = u.querySelector('.js-abnote');
    if (note) {
      note.classList.toggle('hide', !mine);
      var nb = note.querySelector('.js-abmax');
      if (nb) nb.textContent = mine ? KA.inr(l.myMax) : '';
    }
    var box = u.querySelector('.js-autobid');
    if (!box) return;
    if (l.status !== 'open') { box.classList.add('hide'); return; }
    var st = box.querySelector('.js-ab-status');
    if (st) {
      st.classList.toggle('hide', !mine);
      st.classList.toggle('out', passed);
      st.innerHTML = !mine ? '' : passed
        ? 'Your maximum of <b class="js-abmax">' + esc(KA.inr(l.myMax)) + '</b> has been passed'
        : 'Auto-bid on up to <b class="js-abmax">' + esc(KA.inr(l.myMax)) + '</b>';
    }
    var stop = box.querySelector('.ab-stop');
    if (stop) stop.classList.toggle('hide', !mine);
    var set = box.querySelector('.js-ab-set');
    if (set && !set.disabled) set.textContent = mine ? 'Update maximum' : 'Set auto-bid';
    var input = box.querySelector('input[name=max]');
    if (input) {
      input.placeholder = 'At least ' + l.minBid;
      var asking = !box.querySelector('.ab-confirm').classList.contains('hide');
      if (document.activeElement !== input && !input.getAttribute('data-dirty') && !asking) input.value = mine ? l.myMax : '';
    }
  }

  function setMin(msg, unit) {
    msg.className = 'bid-msg';
    msg.textContent = 'Minimum ' + KA.inr(Number(msg.getAttribute('data-min'))) + ' per ' + unit;
  }

  function apply(state) {
    if (!state || !state.lots) return;
    KA.setServerNow(state.now);
    if (phase === 'upcoming' && state.phase !== 'upcoming') return reloadOnce();
    var open = 0, leading = 0, last = 0;
    state.lots.forEach(function (l) {
      var u = units[l.id];
      if (u) patchUnit(u, l);
      if (l.status === 'open') { open++; if (l.leading) leading++; if (l.endsAt > last) last = l.endsAt; }
    });
    if (el('rb-open')) el('rb-open').textContent = open + ' of ' + state.lots.length;
    if (el('rb-leading')) el('rb-leading').textContent = plural(leading, 'lot');
    if (last) {
      if (el('rb-last')) el('rb-last').setAttribute('data-countdown', last);
      document.querySelectorAll('[data-last-close]').forEach(function (n) { n.setAttribute('data-countdown', last); });
    }
    if (state.phase === 'closed' && el('rb-phase')) {
      el('rb-phase').textContent = 'Closed';
      if (el('rb-last')) el('rb-last').closest('.item').classList.add('hide');
    }
    phase = state.phase === 'closed' ? 'closed' : phase;
  }

  var inflight = null, again = false;
  function refresh() {
    if (inflight) { again = true; return inflight; }
    inflight = fetch(stateUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(apply)
      .catch(function () {})
      .then(function () { inflight = null; if (again) { again = false; refresh(); } });
    return inflight;
  }
  var debounce = null;
  function soon(ms) { clearTimeout(debounce); debounce = setTimeout(refresh, ms || 150); }

  /* ---------- Upcoming auctions: reload once bidding opens ---------- */
  function reloadOnce() {
    var key = 'ka-opened-' + auctionId;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    window.location.reload();
  }
  if (phase === 'upcoming') {
    sessionStorage.removeItem('ka-opened-' + auctionId);
    (function waitForStart() {
      var left = startsAt - KA.now();
      if (left > 0) return setTimeout(waitForStart, Math.min(left + 1200, 60000));
      refresh().then(function () { if (phase === 'upcoming') setTimeout(waitForStart, 3000); });
    })();
  }

  /* ---------- Lots reaching their closing time ---------- */
  var closingAsked = {};
  setInterval(function () {
    if (phase !== 'live') return;
    var now = KA.now();
    Object.keys(units).forEach(function (id) {
      var u = units[id];
      if (u.getAttribute('data-status') !== 'open') return;
      var ends = Number(u.getAttribute('data-ends'));
      if (ends && ends < now - 2500 && closingAsked[id] !== ends) { closingAsked[id] = ends; soon(100); }
    });
  }, 1000);

  /* ---------- Live updates ---------- */
  setInterval(refresh, 15000);
  if (typeof window.io === 'function') {
    var socket = window.io({ reconnection: true });
    socket.on('connect', function () { setConn(true); socket.emit('watch', auctionId); refresh(); });
    socket.on('disconnect', function () { setConn(false); });
    socket.on('connect_error', function () { setConn(false); });
    socket.on('lot', function () { soon(150); });
    socket.on('outbid', function (p) {
      KA.toast('You have been outbid on lot ' + (p && p.lotNo ? p.lotNo : ''), 'bad');
      soon(50);
    });
  } else {
    setConn(false);
  }

  /* ---------- Bidding ---------- */
  root.addEventListener('input', function (e) {
    if (e.target.name === 'amount' || e.target.name === 'max') e.target.setAttribute('data-dirty', '1');
  });

  // Quick steps: current highest bid plus N increments (the minimum bid is one increment).
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-step]');
    if (!b) return;
    var u = unitOf(b);
    var msg = u && u.querySelector('.bid-msg');
    var input = u && u.querySelector('.bid-form input[name=amount]');
    if (!msg || !input) return;
    var inc = Number(u.getAttribute('data-increment')) || 0;
    var min = Number(msg.getAttribute('data-min')) || 0;
    input.value = round2(min + (Number(b.getAttribute('data-step')) - 1) * inc);
    input.setAttribute('data-dirty', '1');
    input.focus();
  });

  function showMsg(msg, text, kind, holdMs) {
    msg.className = 'bid-msg' + (msg.classList.contains('ab-msg') ? ' ab-msg' : '') + (kind ? ' ' + kind : '');
    msg.textContent = text;
    msg.setAttribute('data-hold', '1');
    clearTimeout(msg._t);
    msg._t = setTimeout(function () {
      msg.removeAttribute('data-hold');
      var u = unitOf(msg);
      if (!msg.hasAttribute('data-min')) { msg.classList.remove('ok', 'err'); msg.textContent = ''; return; }
      if (u && msg.isConnected) setMin(msg, u.getAttribute('data-unit'));
    }, holdMs || 6000);
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    });
  }

  function send(form, amount) {
    var u = unitOf(form);
    var action = form.closest('.js-action');
    var msg = action.querySelector('.bid-msg');
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Sending';
    fetch(form.getAttribute('action'), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ amount: amount })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (res.ok && res.d.ok) {
        form.querySelector('input[name=amount]').removeAttribute('data-dirty');
        if (res.d.leading === false) showMsg(msg, "Bid placed, but another bidder's auto-bid is higher. Bid again to take the lead.", 'err', 9000);
        else showMsg(msg, 'Bid placed' + (res.d.extended ? '. Closing time extended.' : ''), 'ok', 5000);
      } else {
        showMsg(msg, res.d.error || 'The bid was not accepted. Try again.', 'err', 9000);
      }
    }).catch(function () {
      showMsg(msg, 'No connection to the server. Check your internet and try again; your bid was not placed.', 'err', 9000);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Place bid';
      if (u) u.removeAttribute('data-sig');
      refresh();
    });
  }

  function closeConfirm(action) {
    var box = action.querySelector('.bid-confirm');
    box.classList.add('hide');
    box.innerHTML = '';
    action.querySelector('.bid-form button[type=submit]').disabled = false;
  }

  /* ---------- Auto-bid (lot page) ---------- */
  var NO_CONN = 'No connection to the server. Check your internet and try again.';

  function sendAuto(form, max) {
    var u = unitOf(form);
    var box = form.closest('.js-autobid');
    var msg = box.querySelector('.ab-msg');
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Saving';
    post(form.getAttribute('action'), { max: max }).then(function (res) {
      if (res.ok && res.d.ok) {
        form.querySelector('input[name=max]').removeAttribute('data-dirty');
        btn.textContent = 'Update maximum';
        if (res.d.leading) showMsg(msg, 'Auto-bid on up to ' + KA.inr(res.d.max) + '. You are leading.', 'ok', 7000);
        else showMsg(msg, 'Auto-bid on up to ' + KA.inr(res.d.max) + ", but another bidder's maximum is higher. Raise your maximum to take the lead.", 'err', 10000);
      } else {
        showMsg(msg, res.d.error || 'Your auto-bid was not saved. Try again.', 'err', 9000);
      }
    }).catch(function () {
      showMsg(msg, NO_CONN + ' Your auto-bid was not saved.', 'err', 9000);
    }).then(function () {
      btn.disabled = false;
      if (btn.textContent === 'Saving') btn.textContent = 'Set auto-bid';
      if (u) u.removeAttribute('data-sig');
      refresh();
    });
  }

  function closeAutoConfirm(box) {
    var c = box.querySelector('.ab-confirm');
    c.classList.add('hide');
    c.innerHTML = '';
    box.querySelector('.ab-form button[type=submit]').disabled = false;
  }

  root.addEventListener('submit', function (e) {
    var stop = e.target.closest('.ab-stop');
    if (stop) {
      e.preventDefault();
      var sbox = stop.closest('.js-autobid');
      var sbtn = stop.querySelector('button');
      sbtn.disabled = true;
      post(stop.getAttribute('action')).then(function (res) {
        if (res.ok && res.d.ok) {
          var inp = sbox.querySelector('input[name=max]');
          inp.value = ''; inp.removeAttribute('data-dirty');
          showMsg(sbox.querySelector('.ab-msg'), 'Auto-bid stopped. Bids already placed for you stand.', 'ok', 7000);
        } else {
          showMsg(sbox.querySelector('.ab-msg'), res.d.error || 'Your auto-bid was not stopped. Try again.', 'err', 9000);
        }
      }).catch(function () {
        showMsg(sbox.querySelector('.ab-msg'), NO_CONN, 'err', 9000);
      }).then(function () {
        sbtn.disabled = false;
        var su = unitOf(stop); if (su) su.removeAttribute('data-sig');
        refresh();
      });
      return;
    }

    var abForm = e.target.closest('.ab-form');
    if (abForm) {
      e.preventDefault();
      var box = abForm.closest('.js-autobid');
      var amsg = box.querySelector('.ab-msg');
      var araw = String(abForm.querySelector('input[name=max]').value).replace(/[,\s₹]/g, '');
      var max = Number(araw);
      if (!araw || !isFinite(max) || max <= 0) {
        showMsg(amsg, 'Enter your maximum in rupees, for example 45000.', 'err');
        return;
      }
      var bidMsg = unitOf(abForm).querySelector('.js-action .bid-msg');
      var amin = bidMsg ? Number(bidMsg.getAttribute('data-min')) : 0;
      if (amin && max > amin * 3) {
        // A maximum far above the minimum bid is usually a typing mistake, so ask once, in the page.
        var ask = box.querySelector('.ab-confirm');
        ask.innerHTML = '<span class="small">That is ' + Math.round(max / amin * 10) / 10 + ' times the minimum bid of ' + esc(KA.inr(amin)) + '.</span>' +
          '<button type="button" class="btn btn-accent btn-sm js-yes">Set maximum ' + esc(KA.inr(max)) + '</button>' +
          '<button type="button" class="btn btn-quiet btn-sm js-no">Cancel</button>';
        ask.classList.remove('hide');
        abForm.querySelector('button[type=submit]').disabled = true;
        ask.querySelector('.js-yes').addEventListener('click', function () { closeAutoConfirm(box); sendAuto(abForm, max); });
        ask.querySelector('.js-no').addEventListener('click', function () { closeAutoConfirm(box); abForm.querySelector('input[name=max]').focus(); });
        ask.querySelector('.js-yes').focus();
        return;
      }
      sendAuto(abForm, max);
      return;
    }

    var form = e.target.closest('.bid-form');
    if (!form) return;
    e.preventDefault();
    var action = form.closest('.js-action');
    var msg = action.querySelector('.bid-msg');
    var raw = String(form.querySelector('input[name=amount]').value).replace(/[,\s₹]/g, '');
    var amount = Number(raw);
    if (!raw || !isFinite(amount) || amount <= 0) {
      showMsg(msg, 'Enter your bid in rupees, for example ' + msg.getAttribute('data-min') + '.', 'err');
      return;
    }
    var min = Number(msg.getAttribute('data-min'));
    if (min && amount > min * 1.1) {
      // Large jumps are usually typing mistakes, so ask once, in the page.
      var box = action.querySelector('.bid-confirm');
      box.innerHTML = '<span class="small">That is ' + Math.round((amount / min - 1) * 100) + '% above the minimum.</span>' +
        '<button type="button" class="btn btn-accent btn-sm js-yes">Confirm bid of ' + esc(KA.inr(amount)) + '</button>' +
        '<button type="button" class="btn btn-quiet btn-sm js-no">Cancel</button>';
      box.classList.remove('hide');
      form.querySelector('button[type=submit]').disabled = true;
      box.querySelector('.js-yes').addEventListener('click', function () { closeConfirm(action); send(form, amount); });
      box.querySelector('.js-no').addEventListener('click', function () { closeConfirm(action); form.querySelector('input[name=amount]').focus(); });
      box.querySelector('.js-yes').focus();
      return;
    }
    send(form, amount);
  });

  // Seed signatures and closing times so the first refresh only flashes real changes.
  refresh();
})();
