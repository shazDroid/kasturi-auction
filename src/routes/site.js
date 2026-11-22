const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const settings = require('../lib/settings');
const mailer = require('../lib/mailer');
const bidding = require('../lib/bidding');
const { clean, isEmail, toInt, toMoney, fmtINR, TZ } = require('../lib/util');
const mw = require('../middleware');
const { listedSql, viewerId } = require('./visible');

const { wrap, requireUser } = mw;
const { PHASE_SQL } = bidding;
const router = express.Router();

const wantsJson = (req) => (req.get('accept') || '').includes('json');
const round2 = (n) => Math.round(n * 100) / 100;

/** A local path from the Referer header (same host only), for redirecting back after a form post. */
function refererPath(req) {
  try {
    const u = new URL(req.get('referer') || '');
    if (u.host !== req.get('host')) return null;
    return u.pathname + u.search;
  } catch (e) { return null; }
}
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

/** Columns for auction cards and rows. $uid is the parameter holding the viewer's id (for the watch button). */
const auctionCols = (uid) => `a.id, a.title, a.category, a.location, a.starts_at, a.ends_at, a.cover_id, a.visibility, s.name AS seller_name,
  ${PHASE_SQL} AS phase,
  EXISTS (SELECT 1 FROM watchlist w WHERE w.auction_id = a.id AND w.user_id = ${uid}) AS watching,
  (SELECT count(*)::int FROM lots WHERE auction_id = a.id) AS lot_count,
  (SELECT max(ends_at) FROM lots WHERE auction_id = a.id AND status = 'open') AS last_close,
  (SELECT max(ends_at) FROM lots WHERE auction_id = a.id) AS closed_at`;

const OPEN_ORDER = `(phase = 'live') DESC, CASE WHEN phase = 'live' THEN last_close END ASC, starts_at ASC`;
const CLOSED_ORDER = `closed_at DESC NULLS LAST, id DESC`;

/** Escape LIKE wildcards in user input so a search for "50%" means the text "50%". */
const likeTerm = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';

/**
 * Published auctions the viewer may see, matching the filters, with paging.
 * f: { uid (viewer id, 0 for visitors), q, category, location, phases: ['live','upcoming'] | ['closed'] | ..., limit, offset }
 */
async function findAuctions(f) {
  const params = [f.uid || 0];
  const where = [listedSql(1)];
  const p = (v) => { params.push(v); return '$' + params.length; };
  if (f.q) {
    const t = p(likeTerm(f.q));
    where.push(`(a.title ILIKE ${t} OR a.category ILIKE ${t} OR a.description ILIKE ${t} OR s.name ILIKE ${t}
      OR EXISTS (SELECT 1 FROM lots lq WHERE lq.auction_id = a.id AND (lq.title ILIKE ${t} OR lq.description ILIKE ${t})))`);
  }
  if (f.category) where.push(`a.category = ${p(f.category)}`);
  if (f.location) where.push(`a.location ILIKE ${p(likeTerm(f.location))}`);
  const phases = p(f.phases);
  const inner = `SELECT ${auctionCols('$1')} FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id WHERE ${where.join(' AND ')}`;
  const total = (await db.one(`SELECT count(*)::int AS n FROM (${inner}) x WHERE phase = ANY(${phases}::text[])`, params)).n;
  const order = f.phases.includes('closed') && f.phases.length === 1 ? CLOSED_ORDER : `(phase = 'closed'), ${OPEN_ORDER}`;
  const rows = await db.many(
    `SELECT * FROM (${inner}) x WHERE phase = ANY(${phases}::text[]) ORDER BY ${order} LIMIT ${p(f.limit)} OFFSET ${p(f.offset || 0)}`, params);
  return { total, rows };
}

/** Live auctions first (soonest to close), then upcoming (soonest to start). */
async function openAuctions({ uid = 0, limit = 100, category = '' } = {}) {
  return (await findAuctions({ uid, category, phases: ['live', 'upcoming'], limit })).rows;
}

async function closedAuctions({ uid = 0, limit = 20, offset = 0, category = '' } = {}) {
  return (await findAuctions({ uid, category, phases: ['closed'], limit, offset })).rows;
}

/* ---------------- Home ---------------- */

router.get('/', wrap(async (req, res) => {
  const fmt = res.locals;
  const uid = viewerId(req);
  const board = (await openAuctions({ uid, limit: 9 })).map((a) => boardRow(a, fmt));
  const closed = (await closedAuctions({ uid, limit: 5 })).map((a) => boardRow(a, fmt));
  const counts = await db.one(
    `SELECT
       (SELECT count(*)::int FROM auctions a WHERE ${listedSql(1)} AND a.starts_at <= now()) AS auctions,
       (SELECT count(*)::int FROM lots l JOIN auctions a ON a.id = l.auction_id WHERE ${listedSql(1)} AND l.result = 'awarded') AS lots_sold,
       (SELECT count(*)::int FROM users WHERE NOT blocked) AS bidders,
       (SELECT count(DISTINCT a.seller_id)::int FROM auctions a WHERE ${listedSql(1)} AND a.seller_id IS NOT NULL) AS sellers`, [uid]
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
       FROM auctions a WHERE ${listedSql(1)} AND a.category <> ''
      GROUP BY category ORDER BY open DESC, total DESC, category LIMIT 8`, [uid]
  );
  const filters = await filterOptions(uid);
  res.page('site/home', {
    title: '', fullBleed: true, board, closed, stats: stats.length >= 2 ? stats : [], categories, filters,
    liveNow: board.filter((a) => a.phase === 'live').slice(0, 4),
    nextUp: board.find((a) => a.phase === 'upcoming') || null,
    kyc: settings.bool('require_kyc_approval'), fee: settings.bool('fee_enabled'),
  });
}));

/** Category and location choices for the search forms (auctions this viewer may see). */
async function filterOptions(uid) {
  const categories = (await db.many(
    `SELECT DISTINCT a.category FROM auctions a WHERE ${listedSql(1)} AND a.category <> '' ORDER BY a.category`, [uid || 0]
  )).map((r) => r.category);
  // "Plot 4, MIDC Satpur, Nashik, Maharashtra" -> "Nashik" and "Maharashtra" as suggestions.
  const places = new Set();
  (await db.many(`SELECT DISTINCT a.location FROM auctions a WHERE ${listedSql(1)} AND a.location <> ''`, [uid || 0])).forEach((r) => {
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
  const uid = viewerId(req);
  const filters = await filterOptions(uid);
  const q = clean(req.query.q, 100);
  const location = clean(req.query.location, 80);
  const category = filters.categories.includes(req.query.category) ? req.query.category : '';
  const per = view === 'schedule' ? 25 : 12;
  const first = await findAuctions({ uid, q, category, location, phases: SHOW[show].phases, limit: per, offset: 0 });
  const pages = Math.max(1, Math.ceil(first.total / per));
  const page = Math.min(Math.max(1, toInt(req.query.page, 1)), pages);
  const result = page === 1 ? first : await findAuctions({ uid, q, category, location, phases: SHOW[show].phases, limit: per, offset: (page - 1) * per });
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

// An auction's phase from its times alone, ignoring its status: what bidders would see once it is published.
const TIME_PHASE_SQL = `CASE WHEN now() < a.starts_at THEN 'upcoming'
  WHEN EXISTS (SELECT 1 FROM lots x WHERE x.auction_id = a.id AND x.status = 'open') THEN 'live' ELSE 'closed' END`;

/**
 * Load an auction for the public pages. Bidders and visitors get it only when listedSql() allows
 * (otherwise null, so the page is a 404 exactly like a missing auction). An admin also gets drafts,
 * cancelled and restricted auctions; those come back with .preview set and .phase taken from the times.
 */
async function loadAuction(id, req) {
  if (!id) return null;
  const a = await db.one(
    `SELECT a.*, s.name AS seller_name, s.location AS seller_location, s.description AS seller_description, s.logo_id AS seller_logo,
            ${PHASE_SQL} AS phase, ${TIME_PHASE_SQL} AS time_phase, ${listedSql(2)} AS listed
       FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id
      WHERE a.id = $1 ${req.admin ? '' : `AND ${listedSql(2)}`}`, [id, viewerId(req)]
  );
  if (!a) return null;
  if (!a.listed) {
    a.preview = await previewInfo(a, req);
    a.phase = a.time_phase;
  }
  return a;
}

/** What the admin preview banner needs, and the bidder group chosen with ?as_group=. */
async function previewInfo(a, req) {
  const n = await db.one(
    `SELECT (SELECT count(*)::int FROM auction_groups WHERE auction_id = $1) AS groups,
            (SELECT count(*)::int FROM auction_invites WHERE auction_id = $1) AS invites`, [a.id]
  );
  const groups = await db.many('SELECT id, name FROM bidder_groups ORDER BY name');
  const gid = toInt(req.query.as_group, 0);
  return {
    auctionId: a.id, status: a.status, restricted: a.visibility === 'restricted', groups: n.groups, invites: n.invites,
    groupList: groups, asGroup: groups.find((g) => g.id === gid) || null,
  };
}

/** Preview only: replace start prices and minimum bids with a bidder group's prices (lot_group_prices). */
async function applyGroupPrices(state, auctionId, groupId) {
  const rows = await db.many(
    `SELECT gp.lot_id, gp.start_price, l.increment FROM lot_group_prices gp JOIN lots l ON l.id = gp.lot_id
      WHERE l.auction_id = $1 AND gp.group_id = $2`, [auctionId, groupId]
  );
  const byLot = new Map(rows.map((r) => [r.lot_id, r]));
  state.lots.forEach((l) => {
    const g = byLot.get(l.id);
    if (!g) return;
    l.startPrice = g.start_price;
    l.minBid = l.highest !== null && l.highest !== undefined ? Math.max(g.start_price, round2(l.highest + g.increment))
      : l.bids > 0 ? Math.max(g.start_price, l.minBid) : g.start_price;
  });
}

/**
 * auctionState plus, for the signed-in bidder only, which closed lots were won by them.
 * The caller has already loaded the auction with loadAuction(), which applies the visibility rules.
 */
async function stateFor(auction, user) {
  const auctionId = auction.id;
  const state = await bidding.auctionState(auctionId, user ? user.id : null);
  if (!state) return null;
  const won = user ? new Set((await db.many(
    `SELECT l.id FROM lots l JOIN bids b ON b.id = l.winning_bid_id WHERE l.auction_id = $1 AND b.user_id = $2`,
    [auctionId, user.id]
  )).map((r) => r.id)) : new Set();
  state.lots.forEach((l) => { l.won = won.has(l.id); });
  if (auction.preview) {
    state.phase = auction.phase;
    if (auction.preview.asGroup) await applyGroupPrices(state, auctionId, auction.preview.asGroup.id);
  }
  return state;
}

const auctionDocuments = (id) => db.many(
  `SELECT d.id, d.title, d.file_id, f.mime, f.size, f.filename FROM auction_documents d JOIN files f ON f.id = d.file_id
    WHERE d.auction_id = $1 ORDER BY d.id`, [id]
);

const isWatching = async (user, auctionId) => !!(user && await db.one(
  'SELECT 1 FROM watchlist WHERE user_id = $1 AND auction_id = $2', [user.id, auctionId]
));

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

/** Query string that keeps ?as_group= on links inside an admin preview. */
const previewQuery = (auction) => (auction.preview && auction.preview.asGroup ? '?as_group=' + auction.preview.asGroup.id : '');

router.get('/auctions/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id, 0);
  const auction = await loadAuction(id, req);
  if (!auction) return notFound(res, 'Auction not found', 'This auction does not exist or is no longer listed.');
  const user = req.user;
  const preview = auction.preview || null;
  const canSeeLots = !!user || !!preview || settings.bool('catalogue_public');
  let lots = [];
  let state = null;
  if (canSeeLots) {
    state = await stateFor(auction, user);
    lots = await catalogue(id, state);
  }
  // Auction photos: the first is the cover. Older auctions may only have cover_id.
  let images = await db.many(
    `SELECT ai.file_id, f.width, f.height FROM auction_images ai JOIN files f ON f.id = ai.file_id
      WHERE ai.auction_id = $1 ORDER BY ai.sort_order, ai.id`, [id]
  );
  if (!images.length && auction.cover_id) images = [{ file_id: auction.cover_id, width: null, height: null }];
  const lotEnds = lots.map((l) => l.endsAt);
  const live = auction.phase === 'live';
  const scripts = [];
  if (canSeeLots && (live || auction.phase === 'upcoming')) scripts.push('/socket.io/socket.io.js', '/js/room.js');
  if (images.length) scripts.push('/js/gallery.js');
  res.page('site/auction', {
    title: auction.title,
    auction, lots, state, canSeeLots, images, preview, previewQuery: previewQuery(auction),
    documents: await auctionDocuments(id),
    canBid: !preview && !!(user && res.locals.eligibility && res.locals.eligibility.ok),
    watching: await isWatching(user, id),
    autoBid: settings.bool('proxy_bidding_enabled'),
    lastClose: lotEnds.length ? Math.max(...lotEnds) : new Date(auction.ends_at).getTime(),
    openCount: lots.filter((l) => l.status === 'open').length,
    leadingCount: lots.filter((l) => l.status === 'open' && l.leading).length,
    serverNow: Date.now(),
    scripts,
  });
}));

/* ---------------- Lot detail ---------------- */

router.get('/auctions/:auctionId/lots/:lotId', wrap(async (req, res) => {
  const id = toInt(req.params.auctionId, 0);
  const lotId = toInt(req.params.lotId, 0);
  const auction = await loadAuction(id, req);
  const lotMissing = () => notFound(res, 'Lot not found', 'This lot does not exist or its auction is no longer listed.');
  if (!auction || !lotId) return lotMissing();
  const user = req.user;
  const preview = auction.preview || null;
  if (!user && !preview && !settings.bool('catalogue_public')) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const state = await stateFor(auction, user);
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
    auction, lot, images, state, preview, previewQuery: previewQuery(auction),
    specs: Array.isArray(lot.specs) ? lot.specs.filter((x) => x && x.label && x.value !== undefined && x.value !== '') : [],
    prev: lots[idx - 1] || null, next: lots[idx + 1] || null, lotCount: lots.length,
    documents: await auctionDocuments(id),
    canBid: !preview && !!(user && res.locals.eligibility && res.locals.eligibility.ok),
    watching: await isWatching(user, id),
    autoBid: settings.bool('proxy_bidding_enabled'),
    commission: user ? await bidding.commissionFor(db, user.id) : 0,
    serverNow: Date.now(),
    scripts,
  });
}));

router.get('/auctions/:id/state', wrap(async (req, res) => {
  const id = toInt(req.params.id, 0);
  const auction = await loadAuction(id, req);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (!req.user && !auction.preview && !settings.bool('catalogue_public')) return res.status(401).json({ error: 'Sign in to see lots and prices.' });
  res.set('Cache-Control', 'no-store');
  res.json(await stateFor(auction, req.user));
}));

/* ---------------- Bids and auto-bids ---------------- */

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
    res.redirect(refererPath(req) || '/auctions');
  },
});

/** A lot the signed-in bidder may see (null otherwise, so the answer is the same as for a missing lot). */
const visibleLot = (lotId, req) => (lotId ? db.one(
  `SELECT l.id, l.auction_id, l.lot_no FROM lots l JOIN auctions a ON a.id = l.auction_id WHERE l.id = $1 AND ${listedSql(2)}`,
  [lotId, viewerId(req)]
) : null);

/** Where a form post about a lot returns to: the lot page or auction page it came from, else `fallback`. */
function lotBack(req, lot, fallback) {
  if (!lot) return '/auctions';
  const ref = (refererPath(req) || '').split('?')[0];
  if (ref === `/auctions/${lot.auction_id}/lots/${lot.id}` || ref === `/auctions/${lot.auction_id}`) return ref;
  return fallback;
}

const OUTBID_BY_AUTO = "Bid placed, but another bidder's auto-bid is higher. Bid again to take the lead.";

router.post('/lots/:id/bid', requireUser, bidLimiter, wrap(async (req, res) => {
  const lotId = toInt(req.params.id, 0);
  const amount = toMoney(req.body && req.body.amount);
  const lot = await visibleLot(lotId, req);
  // A bid from the lot page (without JavaScript) returns to that lot page.
  const back = lotBack(req, lot, lot ? '/auctions/' + lot.auction_id : '/auctions');
  try {
    if (!lot) throw new bidding.BidError('This lot does not exist.');
    if (!Number.isFinite(amount)) throw new bidding.BidError('Enter the bid as a number in rupees, for example 32500.');
    const out = await bidding.placeBid({ userId: req.user.id, lotId, amount, ip: req.ip });
    if (wantsJson(req)) return res.json({ ok: true, extended: !!out.extended, leading: !!out.leading });
    if (out.leading) req.flash('ok', `Bid placed on lot ${lot.lot_no}.` + (out.extended ? ' Closing time extended.' : ''));
    else req.flash('info', `Lot ${lot.lot_no}: ${OUTBID_BY_AUTO}`);
    res.redirect(back);
  } catch (err) {
    if (!(err instanceof bidding.BidError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
    res.redirect(back);
  }
}));

router.post('/lots/:id/autobid', requireUser, bidLimiter, wrap(async (req, res) => {
  const lotId = toInt(req.params.id, 0);
  const max = toMoney(req.body && req.body.max);
  const lot = await visibleLot(lotId, req);
  const back = lotBack(req, lot, lot ? `/auctions/${lot.auction_id}/lots/${lot.id}` : '/auctions');
  try {
    if (!lot) throw new bidding.BidError('This lot does not exist.');
    if (!Number.isFinite(max)) throw new bidding.BidError('Enter your maximum as a number in rupees, for example 45000.');
    const out = await bidding.setProxy({ userId: req.user.id, lotId, maxAmount: max });
    if (wantsJson(req)) return res.json({ ok: true, leading: !!out.leading, max: out.max, extended: !!out.extended });
    if (out.leading) req.flash('ok', `Auto-bid on for lot ${lot.lot_no}, up to ${fmtINR(out.max)}. You are leading.`);
    else req.flash('info', `Auto-bid on for lot ${lot.lot_no}, up to ${fmtINR(out.max)}, but another bidder's maximum is higher. Raise your maximum to take the lead.`);
    res.redirect(back);
  } catch (err) {
    if (!(err instanceof bidding.BidError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
    res.redirect(back);
  }
}));

router.post('/lots/:id/autobid/cancel', requireUser, bidLimiter, wrap(async (req, res) => {
  const lotId = toInt(req.params.id, 0);
  const lot = await visibleLot(lotId, req);
  const back = lotBack(req, lot, lot ? `/auctions/${lot.auction_id}/lots/${lot.id}` : '/auctions');
  try {
    if (!lot) throw new bidding.BidError('This lot does not exist.');
    const stopped = await bidding.cancelProxy({ userId: req.user.id, lotId });
    const text = stopped ? `Auto-bid stopped for lot ${lot.lot_no}. Bids already placed for you stand.` : `You had no auto-bid on lot ${lot.lot_no}.`;
    if (wantsJson(req)) return res.json({ ok: true, stopped });
    req.flash(stopped ? 'ok' : 'info', text);
    res.redirect(back);
  } catch (err) {
    if (!(err instanceof bidding.BidError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
    res.redirect(back);
  }
}));

/* ---------------- Watchlist ---------------- */

function watchRoute(on) {
  return wrap(async (req, res) => {
    const id = toInt(req.params.id, 0);
    const back = refererPath(req) || (id ? '/auctions/' + id : '/auctions');
    if (!req.user) {
      // Visitors sign in first and come back to the page they were on.
      req.session.returnTo = back;
      if (wantsJson(req)) return res.status(401).json({ error: 'Sign in to watch auctions.', login: '/login?next=' + encodeURIComponent(back) });
      return res.redirect('/login?next=' + encodeURIComponent(back));
    }
    const auction = id ? await db.one(`SELECT a.id, a.title FROM auctions a WHERE a.id = $1 AND ${listedSql(2)}`, [id, req.user.id]) : null;
    if (!auction) {
      if (wantsJson(req)) return res.status(404).json({ error: 'Auction not found.' });
      return notFound(res, 'Auction not found', 'This auction does not exist or is no longer listed.');
    }
    if (on) await db.query('INSERT INTO watchlist(user_id, auction_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.id, id]);
    else await db.query('DELETE FROM watchlist WHERE user_id = $1 AND auction_id = $2', [req.user.id, id]);
    if (wantsJson(req)) return res.json({ ok: true, watching: on });
    const mins = settings.num('watch_alert_minutes');
    req.flash('ok', on
      ? `You are watching this auction.${mins > 0 ? ` We will email you ${mins} minutes before bidding opens.` : ''} See all watched auctions under My account, Watchlist.`
      : 'You are no longer watching this auction.');
    res.redirect(back);
  });
}
router.post('/auctions/:id/watch', watchRoute(true));
router.post('/auctions/:id/unwatch', watchRoute(false));

// v1 photo URL. Photos now live in lot_images and are served from /media; keep old links working.
router.get('/files/lot/:lotId/image', wrap(async (req, res) => {
  if (!req.user && !settings.bool('catalogue_public')) return res.status(404).end();
  const img = await db.one(
    `SELECT li.file_id FROM lot_images li JOIN lots l ON l.id = li.lot_id JOIN auctions a ON a.id = l.auction_id
      WHERE l.id = $1 AND ${listedSql(2)} ORDER BY li.sort_order, li.id LIMIT 1`, [toInt(req.params.lotId, 0), viewerId(req)]
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
