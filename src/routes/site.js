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

const AUCTION_COLS = `a.id, a.title, a.category, a.location, a.starts_at, a.ends_at, a.cover_id, s.name AS seller_name,
  ${PHASE_SQL} AS phase,
  (SELECT count(*)::int FROM lots WHERE auction_id = a.id) AS lot_count,
  (SELECT max(ends_at) FROM lots WHERE auction_id = a.id AND status = 'open') AS last_close,
  (SELECT max(ends_at) FROM lots WHERE auction_id = a.id) AS closed_at`;

const OPEN_ORDER = `(phase = 'live') DESC, CASE WHEN phase = 'live' THEN last_close END ASC, starts_at ASC`;
const CLOSED_ORDER = `closed_at DESC NULLS LAST, id DESC`;

/** Escape LIKE wildcards in user input so a search for "50%" means the text "50%". */
const likeTerm = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';

/**
 * Published auctions matching the filters, with paging.
 * f: { q, category, location, phases: ['live','upcoming'] | ['closed'] | ..., limit, offset }
 */
async function findAuctions(f) {
  const params = [];
  const where = [`a.status = 'published'`];
  const p = (v) => { params.push(v); return '$' + params.length; };
  if (f.q) {
    const t = p(likeTerm(f.q));
    where.push(`(a.title ILIKE ${t} OR a.category ILIKE ${t} OR a.description ILIKE ${t} OR s.name ILIKE ${t}
      OR EXISTS (SELECT 1 FROM lots lq WHERE lq.auction_id = a.id AND (lq.title ILIKE ${t} OR lq.description ILIKE ${t})))`);
  }
  if (f.category) where.push(`a.category = ${p(f.category)}`);
  if (f.location) where.push(`a.location ILIKE ${p(likeTerm(f.location))}`);
  const phases = p(f.phases);
  const inner = `SELECT ${AUCTION_COLS} FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id WHERE ${where.join(' AND ')}`;
  const total = (await db.one(`SELECT count(*)::int AS n FROM (${inner}) x WHERE phase = ANY(${phases}::text[])`, params)).n;
  const order = f.phases.includes('closed') && f.phases.length === 1 ? CLOSED_ORDER : `(phase = 'closed'), ${OPEN_ORDER}`;
  const rows = await db.many(
    `SELECT * FROM (${inner}) x WHERE phase = ANY(${phases}::text[]) ORDER BY ${order} LIMIT ${p(f.limit)} OFFSET ${p(f.offset || 0)}`, params);
  return { total, rows };
}

/** Live auctions first (soonest to close), then upcoming (soonest to start). */
async function openAuctions({ limit = 100, category = '' } = {}) {
  return (await findAuctions({ category, phases: ['live', 'upcoming'], limit })).rows;
}

async function closedAuctions({ limit = 20, offset = 0, category = '' } = {}) {
  return (await findAuctions({ category, phases: ['closed'], limit, offset })).rows;
}

/* ---------------- Home ---------------- */

router.get('/', wrap(async (req, res) => {
  const fmt = res.locals;
  const board = (await openAuctions({ limit: 9 })).map((a) => boardRow(a, fmt));
  const closed = (await closedAuctions({ limit: 5 })).map((a) => boardRow(a, fmt));
  const counts = await db.one(
    `SELECT
       (SELECT count(*)::int FROM auctions a WHERE a.status = 'published' AND a.starts_at <= now()) AS auctions,
       (SELECT count(*)::int FROM lots l JOIN auctions a ON a.id = l.auction_id WHERE a.status = 'published' AND l.result = 'awarded') AS lots_sold,
       (SELECT count(*)::int FROM users WHERE NOT blocked) AS bidders,
       (SELECT count(DISTINCT a.seller_id)::int FROM auctions a WHERE a.status = 'published' AND a.seller_id IS NOT NULL) AS sellers`
  );
  const stats = [
    [counts.auctions, counts.auctions === 1 ? 'auction conducted' : 'auctions conducted'],
    [counts.lots_sold, counts.lots_sold === 1 ? 'lot sold' : 'lots sold'],
    [counts.bidders, counts.bidders === 1 ? 'registered bidder' : 'registered bidders'],
    [counts.sellers, counts.sellers === 1 ? 'seller' : 'sellers'],
  ].filter((s) => s[0] > 0);
  const categories = await db.many(
    `SELECT category, count(*)::int AS total,
            count(*) FILTER (WHERE ${PHASE_SQL} IN ('live', 'upcoming'))::int AS open
       FROM auctions a WHERE a.status = 'published' AND a.category <> ''
      GROUP BY category ORDER BY open DESC, total DESC, category LIMIT 8`
  );
  const filters = await filterOptions();
  res.page('site/home', {
    title: '', fullBleed: true, board, closed, stats: stats.length >= 2 ? stats : [], categories, filters,
    liveNow: board.filter((a) => a.phase === 'live').slice(0, 4),
    nextUp: board.find((a) => a.phase === 'upcoming') || null,
    kyc: settings.bool('require_kyc_approval'), fee: settings.bool('fee_enabled'),
  });
}));

/** Category and location choices for the search forms (published auctions only). */
async function filterOptions() {
  const categories = (await db.many(
    `SELECT DISTINCT category FROM auctions WHERE status = 'published' AND category <> '' ORDER BY category`
  )).map((r) => r.category);
  // "Plot 4, MIDC Satpur, Nashik, Maharashtra" -> "Nashik" and "Maharashtra" as suggestions.
  const places = new Set();
  (await db.many(`SELECT DISTINCT location FROM auctions WHERE status = 'published' AND location <> ''`)).forEach((r) => {
    const parts = r.location.split(',').map((x) => x.trim()).filter(Boolean);
    parts.slice(-2).forEach((x) => places.add(x));
  });
  return { categories, locations: [...places].sort() };
}

/* ---------------- Auction list ---------------- */

const SHOW = {
  open: { phases: ['live', 'upcoming'], title: 'Live and upcoming auctions' },
  live: { phases: ['live'], title: 'Live auctions' },
  upcoming: { phases: ['upcoming'], title: 'Upcoming auctions' },
  closed: { phases: ['closed'], title: 'Closed auctions' },
};

router.get('/auctions', wrap(async (req, res) => {
  const show = SHOW[req.query.show] ? req.query.show : 'open';
  const view = req.query.view === 'schedule' ? 'schedule' : 'cards';
  const filters = await filterOptions();
  const q = clean(req.query.q, 100);
  const location = clean(req.query.location, 80);
  const category = filters.categories.includes(req.query.category) ? req.query.category : '';
  const per = view === 'schedule' ? 25 : 12;
  const first = await findAuctions({ q, category, location, phases: SHOW[show].phases, limit: per, offset: 0 });
  const pages = Math.max(1, Math.ceil(first.total / per));
  const page = Math.min(Math.max(1, toInt(req.query.page, 1)), pages);
  const result = page === 1 ? first : await findAuctions({ q, category, location, phases: SHOW[show].phases, limit: per, offset: (page - 1) * per });
  // Query string for links that keep the current filters (tab, view and page links add their own part).
  const keep = (over) => {
    const v = { q, category, location, show: show === 'open' ? '' : show, view: view === 'cards' ? '' : view, ...over };
    const s = Object.entries(v).filter(([, x]) => x).map(([k, x]) => k + '=' + encodeURIComponent(x)).join('&');
    return '/auctions' + (s ? '?' + s : '');
  };
  res.page('site/auctions', {
    title: SHOW[show].title, show, view, filters, q, category, location, page, pages, total: result.total, keep,
    rows: result.rows.map((a) => boardRow(a, res.locals)),
    filtered: !!(q || category || location),
  });
}));

/* ---------------- Auction detail and bidding room ---------------- */

const loadAuction = (id) => db.one(
  `SELECT a.*, s.name AS seller_name, s.location AS seller_location, s.description AS seller_description, s.logo_id AS seller_logo,
          ${PHASE_SQL} AS phase
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

const auctionDocuments = (id) => db.many(
  `SELECT d.id, d.title, d.file_id, f.mime, f.size, f.filename FROM auction_documents d JOIN files f ON f.id = d.file_id
    WHERE d.auction_id = $1 ORDER BY d.id`, [id]
);

/** Lot rows for the catalogue: details, first photo and photo count, merged with the live state. */
async function catalogue(auctionId, state) {
  const details = await db.many(
    `SELECT l.id, l.lot_no, l.title, l.description, l.quantity, l.unit, l.start_price, l.increment, l.specs,
            (SELECT li.file_id FROM lot_images li WHERE li.lot_id = l.id ORDER BY li.sort_order, li.id LIMIT 1) AS cover_file,
            (SELECT count(*)::int FROM lot_images li WHERE li.lot_id = l.id) AS photo_count
       FROM lots l WHERE l.auction_id = $1 ORDER BY l.lot_no`, [auctionId]
  );
  const byId = new Map(state.lots.map((l) => [l.id, l]));
  return details.map((d) => ({ ...d, ...byId.get(d.id) }));
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
    state = await stateFor(id, user);
    lots = await catalogue(id, state);
  }
  const lotEnds = lots.map((l) => l.endsAt);
  const live = auction.phase === 'live';
  res.page('site/auction', {
    title: auction.title,
    auction, lots, state, canSeeLots,
    documents: await auctionDocuments(id),
    canBid: !!(user && res.locals.eligibility && res.locals.eligibility.ok),
    lastClose: lotEnds.length ? Math.max(...lotEnds) : new Date(auction.ends_at).getTime(),
    openCount: lots.filter((l) => l.status === 'open').length,
    leadingCount: lots.filter((l) => l.status === 'open' && l.leading).length,
    serverNow: Date.now(),
    scripts: canSeeLots && (live || auction.phase === 'upcoming') ? ['/socket.io/socket.io.js', '/js/room.js'] : [],
  });
}));

/* ---------------- Lot detail ---------------- */

router.get('/auctions/:auctionId/lots/:lotId', wrap(async (req, res) => {
  const id = toInt(req.params.auctionId, 0);
  const lotId = toInt(req.params.lotId, 0);
  const auction = id ? await loadAuction(id) : null;
  const lotMissing = () => notFound(res, 'Lot not found', 'This lot does not exist or its auction is no longer listed.');
  if (!auction || !lotId) return lotMissing();
  const user = req.user;
  if (!user && !settings.bool('catalogue_public')) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const state = await stateFor(id, user);
  const lots = await catalogue(id, state);
  const idx = lots.findIndex((l) => l.id === lotId);
  if (idx < 0) return lotMissing();
  const lot = lots[idx];
  const images = await db.many(
    `SELECT li.file_id, f.width, f.height FROM lot_images li JOIN files f ON f.id = li.file_id
      WHERE li.lot_id = $1 ORDER BY li.sort_order, li.id`, [lotId]
  );
  const live = auction.phase === 'live';
  const scripts = ['/js/gallery.js'];
  if (live || auction.phase === 'upcoming') scripts.unshift('/socket.io/socket.io.js', '/js/room.js');
  res.page('site/lot', {
    title: `Lot ${lot.lot_no}: ${lot.title}`,
    auction, lot, images, state,
    specs: Array.isArray(lot.specs) ? lot.specs.filter((x) => x && x.label && x.value !== undefined && x.value !== '') : [],
    prev: lots[idx - 1] || null, next: lots[idx + 1] || null, lotCount: lots.length,
    documents: await auctionDocuments(id),
    canBid: !!(user && res.locals.eligibility && res.locals.eligibility.ok),
    serverNow: Date.now(),
    scripts,
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
  let back = lot ? '/auctions/' + lot.auction_id : '/auctions';
  // A bid from the lot page (without JavaScript) returns to that lot page.
  try {
    const ref = new URL(req.get('referer') || '', 'http://x').pathname;
    if (lot && ref === `/auctions/${lot.auction_id}/lots/${lotId}`) back = ref;
  } catch (e) { /* keep the auction page */ }
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

// v1 photo URL. Photos now live in lot_images and are served from /media; keep old links working.
router.get('/files/lot/:lotId/image', wrap(async (req, res) => {
  if (!req.user && !settings.bool('catalogue_public')) return res.status(404).end();
  const img = await db.one(
    `SELECT li.file_id FROM lot_images li JOIN lots l ON l.id = li.lot_id JOIN auctions a ON a.id = l.auction_id
      WHERE l.id = $1 AND a.status = 'published' ORDER BY li.sort_order, li.id LIMIT 1`, [toInt(req.params.lotId, 0)]
  );
  if (!img) return res.status(404).end();
  res.redirect(301, '/media/' + img.file_id);
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
