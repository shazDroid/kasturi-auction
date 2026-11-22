// Auctions, lots, live controls and bid history.
const express = require('express');
const db = require('../../db');
const settings = require('../../lib/settings');
const bidding = require('../../lib/bidding');
const worker = require('../../lib/worker');
const { clean, toInt, toMoney, parseLocal, fmtDT, bidderNo } = require('../../lib/util');
const { wrap, audit, upload, saveFile, sendFile, isImage } = require('../../middleware');
const { paginate, notFound, sendCsv, back } = require('./helpers');
const M = require('./media-helpers');

const router = express.Router();
const { PHASE_SQL } = bidding;

const UNITS = ['MT', 'KG', 'Nos', 'Lot', 'Ltr', 'Mtr'];
const PHASES = ['upcoming', 'live', 'closed', 'draft', 'cancelled'];
const PER = 25;

async function loadAuction(id) {
  return db.one(
    `SELECT a.*, ${PHASE_SQL} AS phase, s.name AS seller_name, now() >= a.starts_at AS started, now() >= a.ends_at AS window_over,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id) AS lot_count,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id AND l.status = 'open') AS lots_open,
            (SELECT count(*)::int FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.auction_id = a.id) AS bid_count_all,
            (SELECT count(*)::int FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.auction_id = a.id AND NOT b.cancelled) AS bid_count,
            (SELECT count(DISTINCT b.user_id)::int FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.auction_id = a.id AND NOT b.cancelled) AS bidder_count
       FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id WHERE a.id = $1`, [id]
  );
}

const lotsOf = (auctionId) => db.many(
  `SELECT l.*, (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled) AS bid_count,
          (SELECT li.file_id FROM lot_images li WHERE li.lot_id = l.id ORDER BY li.sort_order, li.id LIMIT 1) AS cover_file_id,
          (SELECT count(*)::int FROM lot_images li WHERE li.lot_id = l.id) AS photo_count,
          t.amount AS top_amount, t.user_id AS top_user, t.name AS top_name, t.company_name AS top_company
     FROM lots l
     LEFT JOIN LATERAL (SELECT b.amount, b.user_id, u.name, u.company_name FROM bids b JOIN users u ON u.id = b.user_id
                         WHERE b.lot_id = l.id AND NOT b.cancelled ORDER BY b.amount DESC, b.id ASC LIMIT 1) t ON true
    WHERE l.auction_id = $1 ORDER BY l.lot_no`, [auctionId]
);

const bidsOf = (auctionId, { lotId = null, limit = 50, offset = 0 } = {}) => db.many(
  `SELECT b.*, l.lot_no, l.title AS lot_title, u.name, u.company_name, u.email, u.phone
     FROM bids b JOIN lots l ON l.id = b.lot_id JOIN users u ON u.id = b.user_id
    WHERE l.auction_id = $1 AND ($2::int IS NULL OR l.id = $2)
    ORDER BY b.id DESC LIMIT $3 OFFSET $4`, [auctionId, lotId, limit, offset]
);

const sellersFor = (currentId) => db.many(
  'SELECT id, name, active FROM sellers WHERE active OR id = $1 ORDER BY name', [currentId || 0]
);

// ---------- List ----------
router.get('/auctions', wrap(async (req, res) => {
  const phase = PHASES.includes(req.query.phase) ? req.query.phase : '';
  const q = clean(req.query.q, 100);
  const where = `WHERE ($1 = '' OR (${PHASE_SQL}) = $1) AND ($2 = '' OR a.title ILIKE '%' || $2 || '%' OR s.name ILIKE '%' || $2 || '%')`;
  const { n } = await db.one(`SELECT count(*)::int AS n FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id ${where}`, [phase, q]);
  const pg = paginate(n, req.query.page, PER);
  const rows = await db.many(
    `SELECT a.id, a.title, a.starts_at, a.ends_at, a.status, ${PHASE_SQL} AS phase, s.name AS seller_name,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id) AS lot_count,
            (SELECT count(*)::int FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.auction_id = a.id AND NOT b.cancelled) AS bid_count
       FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id ${where}
      ORDER BY CASE ${PHASE_SQL} WHEN 'live' THEN 0 WHEN 'upcoming' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
               CASE WHEN (${PHASE_SQL}) IN ('live','upcoming','draft') THEN a.starts_at END ASC,
               a.starts_at DESC
      LIMIT $3 OFFSET $4`, [phase, q, PER, pg.offset]
  );
  res.adminPage('admin/auctions', { title: 'Auctions and lots', rows, pg, phase, q, PHASES });
}));

// ---------- Create / edit ----------
function auctionDefaults() {
  const start = new Date(Date.now() + 2 * 86400000);
  start.setUTCMinutes(30, 0, 0); // a round IST time: hh:00 IST is hh-5:30 UTC
  return {
    title: '', seller_id: null, category: '', location: '', description: '', inspection: '', terms: '',
    starts_at: start, ends_at: new Date(start.getTime() + 3 * 3600000),
    extend_window_min: settings.num('default_extend_window_min'), extend_by_min: settings.num('default_extend_by_min'),
    stagger_min: 0, show_highest_bid: true, auto_award: false, status: 'draft',
  };
}

async function renderAuctionForm(res, { auction, values, errors = {} }) {
  const categories = (await db.many(`SELECT DISTINCT category FROM auctions WHERE category <> '' ORDER BY category`)).map((r) => r.category);
  const locked = !!auction && auction.status === 'published' && auction.started;
  res.adminPage('admin/auction_form', {
    title: auction ? `Edit ${auction.title}` : 'New auction',
    auction, v: values, errors, locked, categories,
    sellers: await sellersFor(values.seller_id),
    ...M.EDITOR_ASSETS,
  });
}

/** Validate the auction form. Returns { values, errors }. */
async function readAuctionForm(body, auction) {
  const e = {};
  const locked = !!auction && auction.status === 'published' && auction.started;
  const v = {
    title: clean(body.title, 200),
    seller_id: toInt(body.seller_id, 0) || null,
    category: clean(body.category, 100),
    location: clean(body.location, 200),
    description: M.readRich(body, 'description', 'The description', e),
    inspection: M.readRich(body, 'inspection', 'The inspection details', e),
    terms: M.readRich(body, 'terms', 'The terms', e),
    extend_window_min: toInt(body.extend_window_min, -1),
    extend_by_min: toInt(body.extend_by_min, -1),
    stagger_min: toInt(body.stagger_min, -1),
    show_highest_bid: body.show_highest_bid === '1',
    auto_award: body.auto_award === '1',
    status: ['draft', 'published', 'cancelled'].includes(body.status) ? body.status : 'draft',
    remove_cover: body.remove_cover === '1',
  };
  if (!v.title) e.title = 'Enter a title, for example "HMS 1 and 2 scrap, Pune plant".';
  if (v.seller_id && !(await db.one('SELECT id FROM sellers WHERE id = $1', [v.seller_id]))) e.seller_id = 'Choose a seller from the list.';
  if (locked) {
    v.starts_at = auction.starts_at;
    v.ends_at = auction.ends_at;
  } else {
    v.starts_at = parseLocal(body.starts_at);
    v.ends_at = parseLocal(body.ends_at);
    if (!v.starts_at) e.starts_at = 'Enter the start date and time.';
    if (!v.ends_at) e.ends_at = 'Enter the closing date and time.';
    if (v.starts_at && v.ends_at && v.ends_at <= v.starts_at) e.ends_at = 'The closing time must be after the start time.';
  }
  if (v.extend_window_min < 0 || v.extend_window_min > 120) e.extend_window_min = 'Enter a whole number of minutes from 0 to 120.';
  if (v.extend_by_min < 0 || v.extend_by_min > 120) e.extend_by_min = 'Enter a whole number of minutes from 0 to 120.';
  if (v.stagger_min < 0 || v.stagger_min > 240) e.stagger_min = 'Enter a whole number of minutes from 0 to 240.';
  if (locked && v.status === 'draft') e.status = 'This auction has started, so it cannot go back to draft. Cancel it instead if it must stop.';
  if (v.status === 'published' && v.ends_at && v.ends_at <= new Date() && !(auction && auction.status === 'published')) {
    e.status = 'The closing time has already passed. Set a future closing time before publishing.';
  }
  return { values: v, errors: e };
}

/** Check the chosen cover photo (not yet stored). Sets errors.cover. */
function checkCover(req, errors) {
  if (M.rejectedNames(req, 'cover').length || (req.file && !isImage(req.file))) {
    errors.cover = 'The cover must be a JPG, PNG or WebP photo. PDFs and other files cannot be used; add them under Documents on the auction page.';
  }
}

const AUCTION_COLS = ['title', 'seller_id', 'category', 'location', 'description', 'inspection', 'terms', 'starts_at', 'ends_at',
  'extend_window_min', 'extend_by_min', 'stagger_min', 'show_highest_bid', 'auto_award', 'status'];

router.get('/auctions/new', wrap(async (req, res) => {
  const v = auctionDefaults();
  if (req.query.seller_id) v.seller_id = toInt(req.query.seller_id, 0) || null;
  await renderAuctionForm(res, { auction: null, values: v });
}));

router.post('/auctions', M.uploads(upload.single('cover')), wrap(async (req, res) => {
  if (req.uploadError) { req.flash('error', `${req.uploadError} The auction was not saved.`); return res.redirect('/admin/auctions/new'); }
  const { values: v, errors } = await readAuctionForm(req.body, null);
  checkCover(req, errors);
  if (!Object.keys(errors).length && req.file) {
    const r = await M.storeImage(req.file);
    if (r.error) errors.cover = r.error; else v.cover_id = r.id;
  }
  if (Object.keys(errors).length) return renderAuctionForm(res, { auction: null, values: v, errors });
  let note = '';
  if (v.status === 'published') { v.status = 'draft'; note = ' It is saved as a draft: add lots, then publish it.'; }
  const cols = [...AUCTION_COLS, 'cover_id'];
  const row = await db.one(
    `INSERT INTO auctions(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
    cols.map((k) => (v[k] === undefined ? null : v[k]))
  );
  audit(req, 'auction.create', `#${row.id} ${v.title}`);
  req.flash('ok', `Auction created.${note || ' Add the lots next.'}`);
  res.redirect(`/admin/auctions/${row.id}`);
}));

router.get('/auctions/:id(\\d+)/edit', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  await renderAuctionForm(res, { auction: a, values: a });
}));

router.post('/auctions/:id(\\d+)', M.uploads(upload.single('cover')), wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (req.uploadError) { req.flash('error', `${req.uploadError} The auction was not saved.`); return res.redirect(`/admin/auctions/${a.id}/edit`); }
  const { values: v, errors } = await readAuctionForm(req.body, a);
  if (v.status === 'published' && a.lot_count === 0) errors.status = 'Add at least one lot before publishing.';
  checkCover(req, errors);
  let coverId = v.remove_cover ? null : a.cover_id;
  if (!Object.keys(errors).length && req.file) {
    const r = await M.storeImage(req.file);
    if (r.error) errors.cover = r.error; else coverId = r.id;
  }
  if (Object.keys(errors).length) return renderAuctionForm(res, { auction: a, values: { ...v, cover_id: a.cover_id }, errors });
  await db.query(
    `UPDATE auctions SET ${AUCTION_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, cover_id = $${AUCTION_COLS.length + 2},
            reminder_sent = CASE WHEN starts_at <> $9 THEN false ELSE reminder_sent END
      WHERE id = $1`,
    [a.id, ...AUCTION_COLS.map((k) => v[k]), coverId]
  );
  if (a.cover_id && a.cover_id !== coverId) await M.deleteFilesIfUnused([a.cover_id]);
  await bidding.recalcLotEnds(a.id);
  const coverNote = coverId !== a.cover_id ? (coverId ? ' cover photo updated' : ' cover photo removed') : '';
  audit(req, 'auction.update', `#${a.id} ${v.title}${v.status !== a.status ? ` (status ${a.status} to ${v.status})` : ''}${coverNote ? ',' + coverNote : ''}`);
  req.flash('ok', `Auction saved.${coverNote ? ` The${coverNote.replace('photo ', 'photo was ')}.` : ''}`);
  res.redirect(`/admin/auctions/${a.id}`);
}));

// ---------- Workspace ----------
async function workspace(id) {
  const a = await loadAuction(id);
  if (!a) return null;
  const [lots, bids] = await Promise.all([lotsOf(id), bidsOf(id)]);
  return { a, lots, bids, serverNow: Date.now() };
}

const docsOf = (auctionId) => db.many(
  `SELECT d.id, d.title, d.file_id, d.created_at, f.filename, f.mime, f.size
     FROM auction_documents d JOIN files f ON f.id = d.file_id WHERE d.auction_id = $1 ORDER BY d.id`, [auctionId]
);

router.get('/auctions/:id(\\d+)', wrap(async (req, res) => {
  const w = await workspace(req.params.id);
  if (!w) return notFound(res, 'This auction');
  res.adminPage('admin/auction', {
    title: w.a.title, ...w, nextLotNo: w.lots.length ? Math.max(...w.lots.map((l) => l.lot_no)) + 1 : 1,
    docs: await docsOf(w.a.id), MAX_DOCS,
    scripts: ['/js/admin.js'],
  });
}));

// ---------- Documents ----------
const MAX_DOCS = 20;

router.post('/auctions/:id(\\d+)/documents', M.uploads(upload.single('file')), wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  const to = `/admin/auctions/${a.id}#documents`;
  if (req.uploadError) { req.flash('error', req.uploadError); return res.redirect(to); }
  if (M.rejectedNames(req, 'file').length) {
    req.flash('error', `${M.rejectedNames(req, 'file')[0]} cannot be added. Upload a PDF, or a JPG, PNG or WebP image.`);
    return res.redirect(to);
  }
  if (!req.file) { req.flash('error', 'Choose a PDF or image file to upload.'); return res.redirect(to); }
  const { n } = await db.one('SELECT count(*)::int AS n FROM auction_documents WHERE auction_id = $1', [a.id]);
  if (n >= MAX_DOCS) { req.flash('error', `This auction already has ${MAX_DOCS} documents. Remove one before adding another.`); return res.redirect(to); }
  const title = clean(req.body.title, 200) || clean(req.file.originalname, 200).replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'Document';
  let fileId;
  if (req.file.mimetype === 'application/pdf') {
    if (req.file.buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
      req.flash('error', `"${req.file.originalname}" is not a valid PDF file. Save it again as PDF and retry.`);
      return res.redirect(to);
    }
    fileId = await saveFile(req.file);
  } else {
    const r = await M.storeImage(req.file);
    if (r.error) { req.flash('error', r.error); return res.redirect(to); }
    fileId = r.id;
  }
  await db.query('INSERT INTO auction_documents(auction_id, file_id, title) VALUES($1,$2,$3)', [a.id, fileId, title]);
  audit(req, 'auction.document_add', `#${a.id} ${title}`);
  req.flash('ok', `Document "${title}" added.${a.status === 'published' ? ' Bidders can open it from the auction page.' : ' Bidders can open it once the auction is published.'}`);
  res.redirect(to);
}));

router.post('/auctions/:id(\\d+)/documents/:docId(\\d+)/delete', wrap(async (req, res) => {
  const d = await db.one('DELETE FROM auction_documents WHERE id = $1 AND auction_id = $2 RETURNING file_id, title', [req.params.docId, req.params.id]);
  if (!d) return notFound(res, 'This document');
  await M.deleteFilesIfUnused([d.file_id]);
  audit(req, 'auction.document_remove', `#${req.params.id} ${d.title}`);
  req.flash('ok', `Document "${d.title}" removed.`);
  res.redirect(`/admin/auctions/${req.params.id}#documents`);
}));

router.get('/auctions/:id(\\d+)/live', wrap(async (req, res) => {
  const w = await workspace(req.params.id);
  if (!w) return res.status(404).end();
  res.render('admin/_auction_live', w);
}));

// ---------- Status actions ----------
router.post('/auctions/:id(\\d+)/publish', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (a.status === 'published') req.flash('info', 'This auction is already published.');
  else if (a.lot_count === 0) req.flash('error', 'Add at least one lot before publishing.');
  else if (a.window_over) req.flash('error', 'The closing time has already passed. Edit the auction and set a future closing time, then publish.');
  else {
    await db.query(`UPDATE auctions SET status = 'published' WHERE id = $1`, [a.id]);
    await bidding.recalcLotEnds(a.id);
    audit(req, 'auction.publish', `#${a.id} ${a.title}`);
    req.flash('ok', a.started ? 'Auction published. Bidding is open now.' : `Auction published. Bidding opens ${fmtDT(a.starts_at)}.`);
  }
  res.redirect(`/admin/auctions/${a.id}`);
}));

router.post('/auctions/:id(\\d+)/unpublish', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (a.status !== 'published') req.flash('info', 'This auction is not published.');
  else if (a.started) req.flash('error', 'Bidding has already started, so this auction cannot go back to draft. Cancel it instead.');
  else {
    await db.query(`UPDATE auctions SET status = 'draft' WHERE id = $1`, [a.id]);
    audit(req, 'auction.unpublish', `#${a.id} ${a.title}`);
    req.flash('ok', 'Auction moved back to draft. Bidders can no longer see it.');
  }
  res.redirect(`/admin/auctions/${a.id}`);
}));

router.post('/auctions/:id(\\d+)/cancel', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (a.status === 'cancelled') req.flash('info', 'This auction is already cancelled.');
  else {
    await db.query(`UPDATE auctions SET status = 'cancelled' WHERE id = $1`, [a.id]);
    audit(req, 'auction.cancel', `#${a.id} ${a.title}`);
    req.flash('ok', 'Auction cancelled. Bidding has stopped and it is hidden from bidders.');
  }
  res.redirect(`/admin/auctions/${a.id}`);
}));

router.post('/auctions/:id(\\d+)/duplicate', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  const newId = await db.tx(async (c) => {
    const copy = (await c.query(
      `INSERT INTO auctions(title, seller_id, category, location, description, inspection, terms, starts_at, ends_at,
                            status, extend_window_min, extend_by_min, stagger_min, show_highest_bid, auto_award)
       SELECT left(title || ' (copy)', 200), seller_id, category, location, description, inspection, terms,
              starts_at + interval '7 days', ends_at + interval '7 days', 'draft',
              extend_window_min, extend_by_min, stagger_min, show_highest_bid, auto_award
         FROM auctions WHERE id = $1 RETURNING id, ends_at`, [a.id]
    )).rows[0];
    // Photos, the cover and documents belong to one auction each (removing one must not break the
    // other), so they are not copied by reference. Text, prices and specifications are.
    await c.query(
      `INSERT INTO lots(auction_id, lot_no, title, description, quantity, unit, start_price, increment, reserve_price, specs, ends_at)
       SELECT $2, lot_no, title, description, quantity, unit, start_price, increment, reserve_price, specs, $3
         FROM lots WHERE auction_id = $1`, [a.id, copy.id, copy.ends_at]
    );
    return copy.id;
  });
  await bidding.recalcLotEnds(newId);
  const { media } = await db.one(
    `SELECT ((SELECT cover_id FROM auctions WHERE id = $1) IS NOT NULL
             OR EXISTS (SELECT 1 FROM lot_images li JOIN lots l ON l.id = li.lot_id WHERE l.auction_id = $1)
             OR EXISTS (SELECT 1 FROM auction_documents WHERE auction_id = $1)) AS media`, [a.id]);
  audit(req, 'auction.duplicate', `#${a.id} to #${newId}`);
  req.flash('ok', `Copy created as a draft, dated 7 days later, with the same lots, descriptions and specifications. ${media
    ? 'The cover photo, lot photos and documents were not copied: upload them again on this copy.'
    : 'Photos and documents are never copied; add them on this copy if needed.'} Check the dates and lots, then publish.`);
  res.redirect(`/admin/auctions/${newId}`);
}));

router.post('/auctions/:id(\\d+)/delete', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (a.bid_count_all > 0) {
    req.flash('error', 'This auction has bids, so it cannot be deleted. Cancel it instead to keep the bid record.');
    return res.redirect(`/admin/auctions/${a.id}`);
  }
  const files = (await db.many(
    `SELECT cover_id AS id FROM auctions WHERE id = $1 AND cover_id IS NOT NULL
     UNION SELECT li.file_id FROM lot_images li JOIN lots l ON l.id = li.lot_id WHERE l.auction_id = $1
     UNION SELECT l.image_id FROM lots l WHERE l.auction_id = $1 AND l.image_id IS NOT NULL
     UNION SELECT file_id FROM auction_documents WHERE auction_id = $1`, [a.id]
  )).map((r) => r.id);
  await db.query('DELETE FROM auctions WHERE id = $1', [a.id]);
  // Lot photos and documents rows went with the auction (ON DELETE CASCADE); now drop their files.
  await M.deleteFilesIfUnused(files);
  audit(req, 'auction.delete', `#${a.id} ${a.title}${files.length ? `, ${files.length} file(s)` : ''}`);
  req.flash('ok', `Auction "${a.title}" and its lots were deleted.`);
  res.redirect('/admin/auctions');
}));

router.post('/auctions/:id(\\d+)/announce', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (a.status !== 'published' || a.phase === 'closed') {
    req.flash('error', 'Only a published auction that has not closed can be announced.');
    return res.redirect(`/admin/auctions/${a.id}`);
  }
  const n = await worker.mailAuction('auction_announcement', a.id);
  await db.query('UPDATE auctions SET announced_at = now() WHERE id = $1', [a.id]);
  audit(req, 'auction.announce', `#${a.id} ${a.title}: ${n} recipients`);
  req.flash('ok', n ? `Announcement queued for ${n} bidder${n === 1 ? '' : 's'}.` : 'No bidders to email yet: nobody has a verified email address with announcements turned on.');
  res.redirect(`/admin/auctions/${a.id}`);
}));

// ---------- Live controls ----------
router.post('/auctions/:id(\\d+)/extend', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  const minutes = toInt(req.body.minutes, 0);
  const lotId = toInt(req.body.lot_id, 0) || null;
  if (minutes < 1 || minutes > 1440) {
    req.flash('error', 'Enter the number of minutes to add, from 1 to 1440.');
    return res.redirect(`/admin/auctions/${a.id}`);
  }
  const rows = await db.many(
    `UPDATE lots SET ends_at = ends_at + make_interval(mins => $2)
      WHERE auction_id = $1 AND status = 'open' AND ($3::int IS NULL OR id = $3) RETURNING id, lot_no`,
    [a.id, minutes, lotId]
  );
  if (!rows.length) {
    req.flash('error', 'No open lots to extend. A lot that has closed cannot be reopened.');
    return res.redirect(`/admin/auctions/${a.id}`);
  }
  if (!lotId) await db.query('UPDATE auctions SET ends_at = ends_at + make_interval(mins => $2) WHERE id = $1', [a.id, minutes]);
  rows.forEach((l) => bidding.broadcastLot(a.id, l.id));
  const what = lotId ? `lot ${rows[0].lot_no}` : `${rows.length} open lot${rows.length === 1 ? '' : 's'}`;
  audit(req, 'auction.extend', `#${a.id} ${what} by ${minutes} min`);
  req.flash('ok', `Closing time of ${what} extended by ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  res.redirect(`/admin/auctions/${a.id}`);
}));

router.post('/lots/:id(\\d+)/close-now', wrap(async (req, res) => {
  const l = await db.one(`UPDATE lots SET ends_at = now() WHERE id = $1 AND status = 'open' RETURNING id, auction_id, lot_no`, [req.params.id]);
  if (!l) {
    req.flash('error', 'This lot is already closed.');
    return res.redirect(back(req, '/admin/auctions'));
  }
  bidding.broadcastLot(l.auction_id, l.id);
  audit(req, 'lot.close_now', `lot #${l.id} (auction #${l.auction_id}, lot ${l.lot_no})`);
  req.flash('ok', `Lot ${l.lot_no} is closing now. Its result appears within a few seconds.`);
  res.redirect(back(req, `/admin/auctions/${l.auction_id}`));
}));

// ---------- Lots ----------
async function renderLotForm(res, { auction, lot, values, errors = {} }) {
  const photos = lot ? await M.lotPhotos(lot.id) : [];
  const specRows = values.specRows || (Array.isArray(values.specs) ? values.specs : []);
  res.adminPage('admin/lot_form', {
    title: lot ? `Edit lot ${lot.lot_no}` : 'Add lot', auction, lot, v: values, errors, UNITS,
    pricesLocked: !!lot && lot.bid_count > 0,
    photos, specRows, SPEC_LABELS: M.SPEC_LABELS, MAX_PHOTOS: M.MAX_PHOTOS, SPEC_ROWS: M.SPEC_ROWS,
    SPEC_LABEL_MAX: M.SPEC_LABEL_MAX, SPEC_VALUE_MAX: M.SPEC_VALUE_MAX,
    ...M.EDITOR_ASSETS,
  });
}

function readLotForm(body, lot) {
  const e = {};
  const priceLocked = !!lot && lot.bid_count > 0;
  const qtyRaw = String(body.quantity ?? '').replace(/[,\s]/g, '');
  const sp = M.readSpecs(body);
  const v = {
    lot_no: toInt(body.lot_no, 0),
    title: clean(body.title, 200),
    description: M.readRich(body, 'description', 'The description', e),
    quantity: /^\d+(\.\d{1,3})?$/.test(qtyRaw) ? Number(qtyRaw) : NaN,
    unit: UNITS.includes(body.unit) ? body.unit : '',
    start_price: priceLocked ? lot.start_price : toMoney(body.start_price),
    increment: priceLocked ? lot.increment : toMoney(body.increment),
    reserve_price: String(body.reserve_price ?? '').trim() === '' ? null : toMoney(body.reserve_price),
    specs: sp.specs,
    specRows: sp.rows,
  };
  if (v.lot_no < 1 || v.lot_no > 9999) e.lot_no = 'Enter a lot number from 1 to 9999.';
  if (!v.title) e.title = 'Enter what is being sold, for example "CRC sheet cuttings".';
  if (!(v.quantity > 0)) e.quantity = 'Enter the quantity as a number, up to 3 decimals.';
  if (!v.unit) e.unit = 'Choose a unit.';
  if (!(v.start_price > 0)) e.start_price = 'Enter the opening price in rupees, for example 42000.';
  if (!(v.increment > 0)) e.increment = 'Enter the minimum raise in rupees, for example 100.';
  if (v.reserve_price !== null && !(v.reserve_price >= 0)) e.reserve_price = 'Enter the reserve in rupees, or leave it empty for no reserve.';
  if (sp.error) e.specs = sp.error;
  return { values: v, errors: e };
}

/** Check the photos chosen on the lot form against type and the per-lot limit. Sets errors.images. */
function checkLotPhotos(req, existing, errors) {
  const files = req.files || [];
  const msg = M.checkPhotos(req, 'images', files);
  if (msg) { errors.images = msg; return; }
  if (existing + files.length > M.MAX_PHOTOS) {
    const room = Math.max(0, M.MAX_PHOTOS - existing);
    errors.images = existing
      ? `A lot can have at most ${M.MAX_PHOTOS} photos. This lot has ${existing}, so you can add ${room === 0 ? 'no more' : room === 1 ? '1 more' : room + ' more'}${room ? '' : ': remove one first'}. You chose ${files.length}.`
      : `A lot can have at most ${M.MAX_PHOTOS} photos. You chose ${files.length}.`;
  }
}

/** Append stored photos to a lot after its current last photo. */
async function addLotPhotos(lotId, fileIds) {
  if (!fileIds.length) return;
  const { last } = await db.one('SELECT COALESCE(max(sort_order), -1) AS last FROM lot_images WHERE lot_id = $1', [lotId]);
  for (let i = 0; i < fileIds.length; i++) {
    await db.query('INSERT INTO lot_images(lot_id, file_id, sort_order) VALUES($1,$2,$3)', [lotId, fileIds[i], last + 1 + i]);
  }
}

const photoWord = (n) => `${n} photo${n === 1 ? '' : 's'}`;

const loadLot = (id) => db.one(
  `SELECT l.*, (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id) AS bid_count,
          (SELECT count(*)::int FROM lot_images li WHERE li.lot_id = l.id) AS photo_count
     FROM lots l WHERE l.id = $1`, [id]
);

router.get('/auctions/:id(\\d+)/lots/new', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (a.window_over) {
    req.flash('error', 'The bidding window of this auction has ended, so lots can no longer be added. Duplicate the auction to sell them again.');
    return res.redirect(`/admin/auctions/${a.id}`);
  }
  const { next } = await db.one('SELECT COALESCE(max(lot_no), 0) + 1 AS next FROM lots WHERE auction_id = $1', [a.id]);
  await renderLotForm(res, {
    auction: a, lot: null,
    values: { lot_no: next, title: '', description: '', quantity: '', unit: 'MT', start_price: '', increment: settings.num('default_increment') || 100, reserve_price: null, specs: [] },
  });
}));

router.post('/auctions/:id(\\d+)/lots', M.uploads(upload.array('images', M.MAX_PHOTOS)), wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  if (req.uploadError) { req.flash('error', `${req.uploadError} The lot was not saved.`); return res.redirect(`/admin/auctions/${a.id}/lots/new`); }
  if (a.window_over) {
    req.flash('error', 'The bidding window of this auction has ended, so lots can no longer be added.');
    return res.redirect(`/admin/auctions/${a.id}`);
  }
  const { values: v, errors } = readLotForm(req.body, null);
  if (!errors.lot_no && await db.one('SELECT 1 FROM lots WHERE auction_id = $1 AND lot_no = $2', [a.id, v.lot_no])) {
    errors.lot_no = `Lot ${v.lot_no} already exists in this auction. Use another number.`;
  }
  checkLotPhotos(req, 0, errors);
  let fileIds = [];
  if (!Object.keys(errors).length && req.files && req.files.length) {
    const r = await M.storeImages(req.files);
    if (r.error) errors.images = r.error; else fileIds = r.ids;
  }
  if (Object.keys(errors).length) return renderLotForm(res, { auction: a, lot: null, values: v, errors });
  const lot = await db.one(
    `INSERT INTO lots(auction_id, lot_no, title, description, quantity, unit, start_price, increment, reserve_price, specs, ends_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
    [a.id, v.lot_no, v.title, v.description, v.quantity, v.unit, v.start_price, v.increment, v.reserve_price, JSON.stringify(v.specs), a.ends_at]
  );
  await addLotPhotos(lot.id, fileIds);
  if (a.started) {
    // recalcLotEnds only runs before the start, so place a late lot in the stagger sequence here.
    await db.query(
      `UPDATE lots SET ends_at = GREATEST(now() + interval '5 minutes', $2::timestamptz + make_interval(mins => $3 * ((SELECT count(*)::int FROM lots WHERE auction_id = $4 AND lot_no < $5))))
        WHERE id = $1`, [lot.id, a.ends_at, a.stagger_min, a.id, v.lot_no]
    );
    bidding.broadcastLot(a.id, lot.id);
  } else {
    await bidding.recalcLotEnds(a.id);
  }
  audit(req, 'lot.create', `auction #${a.id} lot ${v.lot_no} ${v.title}${fileIds.length ? `, ${photoWord(fileIds.length)}` : ''}`);
  req.flash('ok', `Lot ${v.lot_no} added${fileIds.length ? ` with ${photoWord(fileIds.length)}` : ''}.`);
  res.redirect(req.body.and_next === '1' ? `/admin/auctions/${a.id}/lots/new` : `/admin/auctions/${a.id}`);
}));

router.get('/lots/:id(\\d+)/edit', wrap(async (req, res) => {
  const lot = await loadLot(req.params.id);
  if (!lot) return notFound(res, 'This lot');
  const a = await loadAuction(lot.auction_id);
  await renderLotForm(res, { auction: a, lot, values: lot });
}));

router.post('/lots/:id(\\d+)', M.uploads(upload.array('images', M.MAX_PHOTOS)), wrap(async (req, res) => {
  const lot = await loadLot(req.params.id);
  if (!lot) return notFound(res, 'This lot');
  if (req.uploadError) { req.flash('error', `${req.uploadError} The lot was not saved.`); return res.redirect(`/admin/lots/${lot.id}/edit`); }
  const a = await loadAuction(lot.auction_id);
  const { values: v, errors } = readLotForm(req.body, lot);
  if (!errors.lot_no && v.lot_no !== lot.lot_no && await db.one('SELECT 1 FROM lots WHERE auction_id = $1 AND lot_no = $2', [a.id, v.lot_no])) {
    errors.lot_no = `Lot ${v.lot_no} already exists in this auction. Use another number.`;
  }
  checkLotPhotos(req, lot.photo_count, errors);
  let fileIds = [];
  if (!Object.keys(errors).length && req.files && req.files.length) {
    const r = await M.storeImages(req.files);
    if (r.error) errors.images = r.error; else fileIds = r.ids;
  }
  if (Object.keys(errors).length) return renderLotForm(res, { auction: a, lot, values: v, errors });
  await db.query(
    `UPDATE lots SET lot_no = $2, title = $3, description = $4, quantity = $5, unit = $6, start_price = $7, increment = $8,
            reserve_price = $9, specs = $10::jsonb WHERE id = $1`,
    [lot.id, v.lot_no, v.title, v.description, v.quantity, v.unit, v.start_price, v.increment, v.reserve_price, JSON.stringify(v.specs)]
  );
  await addLotPhotos(lot.id, fileIds);
  await bidding.recalcLotEnds(a.id);
  bidding.broadcastLot(a.id, lot.id);
  audit(req, 'lot.update', `lot #${lot.id} (auction #${a.id}, lot ${v.lot_no}) ${v.title}${fileIds.length ? `, added ${photoWord(fileIds.length)}` : ''}`);
  req.flash('ok', `Lot ${v.lot_no} saved${fileIds.length ? `, ${photoWord(fileIds.length)} added` : ''}.`);
  res.redirect(fileIds.length ? `/admin/lots/${lot.id}/edit#photos` : `/admin/auctions/${a.id}`);
}));

// Photo gallery actions from the lot edit page: op = cover | left | right | remove.
router.post('/lots/:id(\\d+)/photos/:photoId(\\d+)', wrap(async (req, res) => {
  const lot = await loadLot(req.params.id);
  if (!lot) return notFound(res, 'This lot');
  const to = `/admin/lots/${lot.id}/edit#photos`;
  const photos = await M.lotPhotos(lot.id);
  const idx = photos.findIndex((p) => p.id === toInt(req.params.photoId, 0));
  if (idx < 0) { req.flash('error', 'That photo is no longer on this lot. The page has been reloaded.'); return res.redirect(to); }
  const op = String(req.body.op || '');
  const photo = photos[idx];
  if (op === 'remove') {
    await db.query('DELETE FROM lot_images WHERE id = $1', [photo.id]);
    // Clear the legacy column too, or the v1 migration in schema.sql would put the photo back.
    await db.query('UPDATE lots SET image_id = NULL WHERE id = $1 AND image_id = $2', [lot.id, photo.file_id]);
    await M.deleteFilesIfUnused([photo.file_id]);
    audit(req, 'lot.photo_remove', `lot #${lot.id} file #${photo.file_id}`);
    req.flash('ok', `Photo removed. Lot ${lot.lot_no} now has ${photoWord(photos.length - 1)}.`);
    return res.redirect(to);
  }
  const order = photos.slice();
  if (op === 'cover') order.unshift(...order.splice(idx, 1));
  else if (op === 'left' && idx > 0) [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
  else if (op === 'right' && idx < order.length - 1) [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
  else if (!['left', 'right', 'cover'].includes(op)) { req.flash('error', 'Choose an action for the photo.'); return res.redirect(to); }
  await db.tx(async (c) => {
    for (let i = 0; i < order.length; i++) await c.query('UPDATE lot_images SET sort_order = $2 WHERE id = $1', [order[i].id, i]);
  });
  req.flash('ok', op === 'cover' ? 'Cover photo changed. It is shown first on the auction page.' : 'Photo order saved.');
  res.redirect(to);
}));

router.post('/lots/:id(\\d+)/delete', wrap(async (req, res) => {
  const lot = await loadLot(req.params.id);
  if (!lot) return notFound(res, 'This lot');
  if (lot.bid_count > 0) {
    req.flash('error', `Lot ${lot.lot_no} has bids, so it cannot be deleted. Close it now and reject the result instead.`);
    return res.redirect(`/admin/auctions/${lot.auction_id}`);
  }
  const files = (await M.lotPhotos(lot.id)).map((p) => p.file_id).concat(lot.image_id ? [lot.image_id] : []);
  await db.query('DELETE FROM lots WHERE id = $1', [lot.id]);
  await M.deleteFilesIfUnused(files);
  await bidding.recalcLotEnds(lot.auction_id);
  bidding.broadcastLot(lot.auction_id, lot.id);
  audit(req, 'lot.delete', `lot #${lot.id} (auction #${lot.auction_id}, lot ${lot.lot_no}) ${lot.title}`);
  req.flash('ok', `Lot ${lot.lot_no} deleted${files.length ? ` with its ${photoWord(lot.photo_count)}` : ''}.`);
  res.redirect(`/admin/auctions/${lot.auction_id}`);
}));

// Lot photos and other stored files, for admin pages.
router.get('/files/:id(\\d+)', wrap(async (req, res) => sendFile(res, req.params.id, { inline: true })));

// ---------- Bids ----------
router.get('/auctions/:id(\\d+)/bids', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return notFound(res, 'This auction');
  const lots = await db.many('SELECT id, lot_no, title FROM lots WHERE auction_id = $1 ORDER BY lot_no', [a.id]);
  const lotId = lots.some((l) => l.id === toInt(req.query.lot, 0)) ? toInt(req.query.lot, 0) : null;
  const { n } = await db.one(
    'SELECT count(*)::int AS n FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.auction_id = $1 AND ($2::int IS NULL OR l.id = $2)', [a.id, lotId]
  );
  const pg = paginate(n, req.query.page, 100);
  const bids = await bidsOf(a.id, { lotId, limit: pg.per, offset: pg.offset });
  res.adminPage('admin/auction_bids', { title: `Bids: ${a.title}`, a, lots, lotId, bids, pg });
}));

router.get('/auctions/:id(\\d+)/bids.csv', wrap(async (req, res) => {
  const a = await loadAuction(req.params.id);
  if (!a) return res.status(404).end();
  const bids = await bidsOf(a.id, { limit: 1000000 });
  const rows = [['Time (IST)', 'Lot no', 'Lot', 'Bidder no', 'Bidder', 'Company', 'Email', 'Phone', 'Amount (INR)', 'IP', 'Cancelled', 'Cancel note']];
  for (const b of bids.reverse()) {
    rows.push([fmtDT(b.created_at), b.lot_no, b.lot_title, bidderNo(b.user_id), b.name, b.company_name, b.email, b.phone, b.amount, b.ip, b.cancelled ? 'Yes' : 'No', b.cancel_note]);
  }
  audit(req, 'auction.export_bids', `#${a.id}`);
  sendCsv(res, `bids-auction-${a.id}.csv`, rows);
}));

const loadBid = (id) => db.one(
  `SELECT b.*, l.lot_no, l.title AS lot_title, l.status AS lot_status, l.winning_bid_id, l.auction_id, a.title AS auction_title,
          u.name, u.company_name
     FROM bids b JOIN lots l ON l.id = b.lot_id JOIN auctions a ON a.id = l.auction_id JOIN users u ON u.id = b.user_id
    WHERE b.id = $1`, [id]
);

router.get('/bids/:id(\\d+)/cancel', wrap(async (req, res) => {
  const bid = await loadBid(req.params.id);
  if (!bid) return notFound(res, 'This bid');
  res.adminPage('admin/bid_cancel', { title: 'Cancel bid', bid, error: '' });
}));

router.post('/bids/:id(\\d+)/cancel', wrap(async (req, res) => {
  const bid = await loadBid(req.params.id);
  if (!bid) return notFound(res, 'This bid');
  const note = clean(req.body.note, 500);
  if (!note) return res.adminPage('admin/bid_cancel', { title: 'Cancel bid', bid, error: 'Write the reason for cancelling. It is kept with the bid record.' });
  const done = await bidding.cancelBid(bid.id, note);
  if (!done) req.flash('info', 'This bid was already cancelled.');
  else {
    audit(req, 'bid.cancel', `bid #${bid.id} ${bid.amount} by ${bidderNo(bid.user_id)} on auction #${bid.auction_id} lot ${bid.lot_no}: ${note}`);
    req.flash('ok', `Bid cancelled. ${bid.lot_status === 'closed' && Number(bid.winning_bid_id) === Number(bid.id) ? 'The next highest bid is now the leading bid for this lot and awaits a decision.' : 'The lot now shows the next highest bid.'}`);
  }
  res.redirect(`/admin/auctions/${bid.auction_id}`);
}));

module.exports = router;
module.exports.loadAuction = loadAuction;
