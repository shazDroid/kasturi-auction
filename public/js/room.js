// Bidding room (auction detail page). The server renders every row; this script keeps the rows
// current from GET /auctions/:id/state (on socket "lot" events, every 15 s and on reconnect)
// and submits bids with fetch.
(function () {
  var table = document.getElementById('lots');
  if (!table) return;

  var auctionId = table.getAttribute('data-auction');
  var phase = table.getAttribute('data-phase');
  var startsAt = Number(table.getAttribute('data-starts'));
  var signedIn = table.getAttribute('data-user') === '1';
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var rows = {};
  table.querySelectorAll('tbody tr[data-lot]').forEach(function (tr) { rows[tr.getAttribute('data-lot')] = tr; });

  var el = function (id) { return document.getElementById(id); };
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
  var clockFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  var dtFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  var fmtTime = function (ms) { return timeFmt.format(new Date(ms)).toLowerCase(); };
  var fmtDT = function (ms) { return dtFmt.format(new Date(ms)) + ', ' + fmtTime(ms); };

  // Same wording as resultFor() in views/site/auction.ejs.
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
    el('rb-conn-text').textContent = on ? 'Live updates on' : 'Reconnecting';
  }

  /* ---------- Applying state ---------- */
  function patchRow(tr, l) {
    var unit = tr.getAttribute('data-unit');
    var wasOpen = tr.getAttribute('data-status') === 'open';
    var sig = [l.status, l.result, l.highest, l.bids, l.endsAt, l.leading, l.myBid].join('|');
    var changed = tr.getAttribute('data-sig') !== null && tr.getAttribute('data-sig') !== sig;
    tr.setAttribute('data-sig', sig);
    tr.setAttribute('data-status', l.status);
    tr.setAttribute('data-ends', l.endsAt);

    // Highest bid and bid count
    var high = tr.querySelector('.js-high > div');
    var top = l.highest !== null && l.highest !== undefined
      ? '<span class="price">' + esc(KA.inr(l.highest)) + '</span>'
      : '<span class="muted">' + (l.bids > 0 ? 'Hidden' : 'No bids yet') + '</span>';
    high.innerHTML = top + '<span class="sub">' + plural(l.bids, 'bid') + '</span>';

    // Closing time
    var close = tr.querySelector('.js-close > div');
    if (l.status === 'open' && phase === 'live') {
      var cd = close.querySelector('.countdown');
      if (!cd) {
        close.innerHTML = '<span class="countdown" data-done="Closing"></span><span class="sub"></span>';
        cd = close.querySelector('.countdown');
      }
      cd.setAttribute('data-countdown', l.endsAt);
      close.querySelector('.sub').textContent = 'at ' + fmtTime(l.endsAt);
    } else if (l.status === 'closed' && wasOpen) {
      close.innerHTML = '<span>Closed</span><span class="sub">' + esc(fmtDT(l.endsAt)) + '</span>';
    }

    // Standing
    var st = tr.querySelector('.js-standing');
    var mine = signedIn && l.myBid !== null && l.myBid !== undefined;
    st.className = 'js-standing standing' + (!mine ? '' : l.status !== 'open' ? ' done' : l.leading ? ' lead' : ' out');
    st.textContent = !mine ? ''
      : l.status !== 'open' ? 'Your highest bid ' + KA.inr(l.myBid)
      : l.leading ? 'Leading with ' + KA.inr(l.myBid)
      : 'Outbid. Your bid ' + KA.inr(l.myBid);
    tr.classList.toggle('leading', mine && (l.status === 'open' ? l.leading : !!l.won));
    tr.classList.toggle('outbid', mine && l.status === 'open' && !l.leading);

    // Bid form or result
    var action = tr.querySelector('.js-action');
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
    if (changed) {
      tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash');
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
      var tr = rows[l.id];
      if (tr) patchRow(tr, l);
      if (l.status === 'open') { open++; if (l.leading) leading++; if (l.endsAt > last) last = l.endsAt; }
    });
    if (el('rb-open')) el('rb-open').textContent = open + ' of ' + state.lots.length;
    if (el('rb-leading')) el('rb-leading').textContent = plural(leading, 'lot');
    if (el('rb-last') && last) el('rb-last').setAttribute('data-countdown', last);
    if (state.phase === 'closed' && el('rb-phase')) {
      el('rb-phase').textContent = 'Closed';
      if (el('rb-last')) el('rb-last').closest('.item').classList.add('hide');
    }
    phase = state.phase === 'closed' ? 'closed' : phase;
  }

  var inflight = null, again = false;
  function refresh() {
    if (inflight) { again = true; return inflight; }
    inflight = fetch('/auctions/' + auctionId + '/state', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' })
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
    Object.keys(rows).forEach(function (id) {
      var tr = rows[id];
      if (tr.getAttribute('data-status') !== 'open') return;
      var ends = Number(tr.getAttribute('data-ends'));
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
  table.addEventListener('input', function (e) {
    if (e.target.name === 'amount') e.target.setAttribute('data-dirty', '1');
  });

  function showMsg(msg, text, kind, holdMs) {
    msg.className = 'bid-msg ' + (kind || '');
    msg.textContent = text;
    msg.setAttribute('data-hold', '1');
    clearTimeout(msg._t);
    msg._t = setTimeout(function () {
      msg.removeAttribute('data-hold');
      var tr = msg.closest('tr');
      if (tr && msg.isConnected) setMin(msg, tr.getAttribute('data-unit'));
    }, holdMs || 6000);
  }

  function send(form, amount) {
    var tr = form.closest('tr');
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
        showMsg(msg, 'Bid placed' + (res.d.extended ? '. Closing time extended.' : ''), 'ok', 5000);
      } else {
        showMsg(msg, res.d.error || 'The bid was not accepted. Try again.', 'err', 9000);
      }
    }).catch(function () {
      showMsg(msg, 'No connection to the server. Check your internet and try again; your bid was not placed.', 'err', 9000);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Place bid';
      if (tr) tr.removeAttribute('data-sig');
      refresh();
    });
  }

  function closeConfirm(action) {
    var box = action.querySelector('.bid-confirm');
    box.classList.add('hide');
    box.innerHTML = '';
    action.querySelector('.bid-form button[type=submit]').disabled = false;
  }

  table.addEventListener('submit', function (e) {
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
