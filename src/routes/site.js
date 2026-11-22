const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const settings = require('../lib/settings');
const mailer = require('../lib/mailer');
const bidding = require('../lib/bidding');
const { clean, isEmail, toInt, toMoney, TZ } = require('../lib/util');
const mw = require('../middleware');

const { wrap, requireUser } = mw;
const { PHASE_SQL } = bidding;
const router = express.Router();

const wantsJson = (req) => (req.get('accept') || '').includes('json');
const notFound = (res, title = 'Page not found', message = 'This page does not exist or has been moved.') =>
  res.status(404).render('error', { title, message });

/* ---------------- Board helpers ---------------- */

const partsFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', weekday: 'short' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Adds the display fields the auction board needs (all in IST). */
function boardRow(a, fmt) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(a.starts_at)).map((x) => [x.type, x.value]));
  const sameDay = dayKey.format(new Date(a.starts_at)) === dayKey.format(new Date(a.ends_at));
  return {
    ...a,
    dayNum: p.day,
    month: p.month,
    weekday: p.weekday,
    window: sameDay
      ? `${fmt.fmtTime(a.starts_at)} to ${fmt.fmtTime(a.ends_at)}`
      : `${fmt.fmtTime(a.starts_at)} to ${fmt.fmtDate(a.ends_at).replace(/ \d{4}$/, '')}, ${fmt.fmtTime(a.ends_at)}`,
    closeAt: a.last_close ? new Date(a.last_close).getTime() : new Date(a.ends_at).getTime(),
    startAt: new Date(a.starts_at).getTime(),
  };
}

const AUCTION_COLS = `a.id, a.title, a.category, a.location, a.starts_at, a.ends_at, s.name AS seller_name,
  ${PHASE_SQL} AS phase,
  (SELECT count(*)::int FROM lots WHERE auction_id = a.id) AS lot_count,
  (SELECT max(ends_at) FROM lots WHERE auction_id = a.id AND status = 'open') AS last_close,
  (SELECT max(ends_at) FROM lots WHERE auction_id = a.id) AS closed_at`;

/** Live auctions first (soonest to close), then upcoming (soonest to start). */
async function openAuctions({ limit = 100, category = '' } = {}) {
  return db.many(
    `SELECT * FROM (
       SELECT ${AUCTION_COLS} FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id
        WHERE a.status = 'published' AND ($2 = '' OR a.category = $2)
     ) x WHERE phase IN ('live', 'upcoming')
     ORDER BY (phase = 'live') DESC, CASE WHEN phase = 'live' THEN last_close END ASC, starts_at ASC
     LIMIT $1`, [limit, category]
  );
}

async function closedAuctions({ limit = 20, offset = 0, category = '' } = {}) {
  const rows = await db.many(
    `SELECT * FROM (
       SELECT ${AUCTION_COLS} FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id
        WHERE a.status = 'published' AND ($3 = '' OR a.category = $3)
     ) x WHERE phase = 'closed'
     ORDER BY closed_at DESC NULLS LAST, id DESC LIMIT $1 OFFSET $2`, [limit, offset, category]
  );
  return rows;
}

/* ---------------- Home ---------------- */

router.get('/', wrap(async (req, res) => {
  const fmt = res.locals;
  const board = (await openAuctions({ limit: 8 })).map((a) => boardRow(a, fmt));
  const closed = await closedAuctions({ limit: 6 });
  res.page('site/home', {
    title: '', fullBleed: true, board, closed,
    kyc: settings.bool('require_kyc_approval'), fee: settings.bool('fee_enabled'),
  });
}));

/* ---------------- Auction list ---------------- */

router.get('/auctions', wrap(async (req, res) => {
  const show = req.query.show === 'closed' ? 'closed' : 'open';
  const categories = (await db.many(
    `SELECT DISTINCT category FROM auctions WHERE status = 'published' AND category <> '' ORDER BY category`
  )).map((r) => r.category);
  const category = categories.includes(req.query.category) ? req.query.category : '';
  const data = { title: show === 'closed' ? 'Closed auctions' : 'Auction schedule', show, categories, category, page: 1, pages: 1, rows: [], board: [] };
  if (show === 'open') {
    data.board = (await openAuctions({ category })).map((a) => boardRow(a, res.locals));
  } else {
    const per = 20;
    const total = (await db.one(
      `SELECT count(*)::int AS n FROM auctions a
        WHERE a.status = 'published' AND ($1 = '' OR a.category = $1) AND ${PHASE_SQL} = 'closed'`, [category]
    )).n;
    data.pages = Math.max(1, Math.ceil(total / per));
    data.page = Math.min(Math.max(1, toInt(req.query.page, 1)), data.pages);
    data.total = total;
    data.rows = await closedAuctions({ limit: per, offset: (data.page - 1) * per, category });
  }
  res.page('site/auctions', data);
}));

/* ---------------- Auction detail and bidding room ---------------- */

const loadAuction = (id) => db.one(
  `SELECT a.*, s.name AS seller_name, ${PHASE_SQL} AS phase
     FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id
    WHERE a.id = $1 AND a.status = 'published'`, [id]
);

/** auctionState plus, for the signed-in bidder only, which closed lots were won by them. */
async function stateFor(auctionId, user) {
  const state = await bidding.auctionState(auctionId, user ? user.id : null);
  if (!state) return null;
  const won = user ? new Set((await db.many(
    `SELECT l.id FROM lots l JOIN bids b ON b.id = l.winning_bid_id WHERE l.auction_id = $1 AND b.user_id = $2`,
    [auctionId, user.id]
  )).map((r) => r.id)) : new Set();
  state.lots.forEach((l) => { l.won = won.has(l.id); });
  return state;
}

router.get('/auctions/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id, 0);
  const auction = id ? await loadAuction(id) : null;
  if (!auction) return notFound(res, 'Auction not found', 'This auction does not exist or is no longer listed.');
  const user = req.user;
  const canSeeLots = !!user || settings.bool('catalogue_public');
  let lots = [];
  let state = null;
  if (canSeeLots) {
    const details = await db.many(
      `SELECT id, lot_no, title, description, quantity, unit, start_price, image_id FROM lots WHERE auction_id = $1 ORDER BY lot_no`, [id]
    );
    state = await stateFor(id, user);
    const byId = new Map(state.lots.map((l) => [l.id, l]));
    lots = details.map((d) => ({ ...d, ...byId.get(d.id) }));
  }
  const lotEnds = lots.map((l) => l.endsAt);
  const live = auction.phase === 'live';
  res.page('site/auction', {
    title: auction.title,
    auction, lots, state, canSeeLots,
    canBid: !!(user && res.locals.eligibility && res.locals.eligibility.ok),
    lastClose: lotEnds.length ? Math.max(...lotEnds) : new Date(auction.ends_at).getTime(),
    openCount: lots.filter((l) => l.status === 'open').length,
    leadingCount: lots.filter((l) => l.status === 'open' && l.leading).length,
    serverNow: Date.now(),
    scripts: canSeeLots && (live || auction.phase === 'upcoming') ? ['/socket.io/socket.io.js', '/js/room.js'] : [],
  });
}));

router.get('/auctions/:id/state', wrap(async (req, res) => {
  const id = toInt(req.params.id, 0);
  const auction = id ? await db.one(`SELECT id FROM auctions WHERE id = $1 AND status = 'published'`, [id]) : null;
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (!req.user && !settings.bool('catalogue_public')) return res.status(401).json({ error: 'Sign in to see lots and prices.' });
  res.set('Cache-Control', 'no-store');
  res.json(await stateFor(id, req.user));
}));

const bidLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => 'bid:' + req.user.id,
  handler: (req, res) => {
    const error = 'You are bidding too fast. Wait a few seconds and try again.';
    if (wantsJson(req)) return res.status(429).json({ error });
    req.flash('error', error);
    res.redirect(req.get('referer') || '/auctions');
  },
});

router.post('/lots/:id/bid', requireUser, bidLimiter, wrap(async (req, res) => {
  const lotId = toInt(req.params.id, 0);
  const amount = toMoney(req.body && req.body.amount);
  const lot = lotId ? await db.one('SELECT auction_id, lot_no FROM lots WHERE id = $1', [lotId]) : null;
  const back = lot ? '/auctions/' + lot.auction_id : '/auctions';
  try {
    if (!lot) throw new bidding.BidError('This lot does not exist.');
    if (!Number.isFinite(amount)) throw new bidding.BidError('Enter the bid as a number in rupees, for example 32500.');
    const out = await bidding.placeBid({ userId: req.user.id, lotId, amount, ip: req.ip });
    if (wantsJson(req)) return res.json({ ok: true, extended: !!out.extended });
    req.flash('ok', `Bid placed on lot ${lot.lot_no}.` + (out.extended ? ' Closing time extended.' : ''));
    res.redirect(back);
  } catch (err) {
    if (!(err instanceof bidding.BidError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
    res.redirect(back);
  }
}));

router.get('/files/lot/:lotId/image', wrap(async (req, res) => {
  if (!req.user && !settings.bool('catalogue_public')) return res.status(404).end();
  const lot = await db.one(
    `SELECT l.image_id FROM lots l JOIN auctions a ON a.id = l.auction_id
      WHERE l.id = $1 AND a.status = 'published' AND l.image_id IS NOT NULL`, [toInt(req.params.lotId, 0)]
  );
  if (!lot) return res.status(404).end();
  await mw.sendFile(res, lot.image_id);
}));

/* ---------------- Content pages ---------------- */

['how-it-works', 'about', 'terms', 'privacy'].forEach((slug) => {
  router.get('/' + slug, wrap(async (req, res) => {
    const page = await db.one('SELECT title, body, updated_at FROM pages WHERE slug = $1', [slug]);
    if (!page) return notFound(res);
    res.page('site/page', { title: page.title, page, slug });
  }));
});

/* ---------------- Contact ---------------- */

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429);
    res.page('site/contact', {
      title: 'Contact us', values: contactValues(req.body), errors: {},
      formError: 'You have sent several messages in the last hour. Wait a while, or email or call us directly.',
    });
  },
});

const contactValues = (b = {}) => ({
  name: clean(b.name, 100), email: clean(b.email, 200).toLowerCase(), phone: clean(b.phone, 20),
  company: clean(b.company, 150), message: clean(b.message, 4000),
});

router.get('/contact', (req, res) => {
  const u = req.user;
  const values = u ? { name: u.name, email: u.email, phone: u.phone, company: u.company_name, message: '' }
    : { name: '', email: '', phone: '', company: '', message: '' };
  res.page('site/contact', { title: 'Contact us', values, errors: {}, formError: '' });
});

router.post('/contact', contactLimiter, wrap(async (req, res) => {
  const v = contactValues(req.body);
  // Honeypot: real people never see or fill the "website" field.
  if (clean(req.body.website)) {
    req.flash('ok', 'Thank you. We have received your message and will reply within one working day.');
    return res.redirect('/contact');
  }
  const e = {};
  if (v.name.length < 2) e.name = 'Enter your name.';
  if (!isEmail(v.email)) e.email = 'Enter a valid email address so we can reply.';
  if (v.phone && !/^\+?[0-9]{8,13}$/.test(v.phone.replace(/[\s\-()]/g, ''))) e.phone = 'Enter a phone number with digits only, or leave it empty.';
  if (v.message.length < 10) e.message = 'Tell us a little more: what material, quantity or question is this about?';
  if (Object.keys(e).length) {
    res.status(422);
    return res.page('site/contact', { title: 'Contact us', values: v, errors: e, formError: '' });
  }
  await db.query('INSERT INTO enquiries(name, email, phone, company, message) VALUES($1,$2,$3,$4,$5)',
    [v.name, v.email, v.phone, v.company, v.message]);
  await mailer.send('enquiry_ack', v.email, { name: v.name, message: v.message }).catch((err) => console.error('enquiry ack', err.message));
  await mailer.notifyAdmin('enquiry_admin', v).catch((err) => console.error('enquiry admin', err.message));
  req.flash('ok', 'Thank you. We have received your message and will reply within one working day.');
  res.redirect('/contact');
}));

module.exports = router;
