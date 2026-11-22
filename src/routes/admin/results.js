// Closed lots: award or reject, lot detail with runner-up bids, results export.
const express = require('express');
const db = require('../../db');
const bidding = require('../../lib/bidding');
const { clean, toInt, fmtDT, bidderNo } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { paginate, notFound, sendCsv, back, label } = require('./helpers');
const { lotPhotos } = require('./media-helpers');

const router = express.Router();
const FILTERS = { pending: 'Awaiting decision', awarded: 'Awarded', rejected: 'Rejected', no_bids: 'No bids' };

const RESULT_SELECT = `
  SELECT l.id, l.lot_no, l.title, l.quantity, l.unit, l.reserve_price, l.ends_at, l.status, l.result, l.result_note,
         a.id AS auction_id, a.title AS auction_title,
         w.id AS bid_id, w.amount, w.user_id, u.name, u.company_name, u.phone, u.email,
         (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled) AS bid_count
    FROM lots l JOIN auctions a ON a.id = l.auction_id
    LEFT JOIN bids w ON w.id = l.winning_bid_id
    LEFT JOIN users u ON u.id = w.user_id`;

router.get('/results', wrap(async (req, res) => {
  const filter = FILTERS[req.query.result] ? req.query.result : 'pending';
  const auctionId = toInt(req.query.auction, 0) || null;
  const where = `WHERE l.status = 'closed' AND l.result = $1 AND ($2::int IS NULL OR a.id = $2)`;
  const { n } = await db.one(`SELECT count(*)::int AS n FROM lots l JOIN auctions a ON a.id = l.auction_id ${where}`, [filter, auctionId]);
  const pg = paginate(n, req.query.page, 50);
  const rows = await db.many(`${RESULT_SELECT} ${where} ORDER BY l.ends_at ${filter === 'pending' ? 'ASC' : 'DESC'}, a.id, l.lot_no LIMIT $3 OFFSET $4`,
    [filter, auctionId, pg.per, pg.offset]);
  const counts = Object.fromEntries((await db.many(
    `SELECT l.result, count(*)::int AS n FROM lots l WHERE l.status = 'closed' AND ($1::int IS NULL OR l.auction_id = $1) GROUP BY l.result`, [auctionId]
  )).map((r) => [r.result, r.n]));
  const auctions = await db.many(
    `SELECT DISTINCT a.id, a.title, a.ends_at FROM auctions a JOIN lots l ON l.auction_id = a.id WHERE l.status = 'closed' ORDER BY a.ends_at DESC LIMIT 200`
  );
  res.adminPage('admin/results', { title: 'Results', rows, pg, filter, FILTERS, counts, auctionId, auctions });
}));

router.post('/lots/:id(\\d+)/decide', wrap(async (req, res) => {
  const decision = ['awarded', 'rejected'].includes(req.body.decision) ? req.body.decision : null;
  const note = clean(req.body.note, 500);
  const before = await db.one('SELECT l.id, l.lot_no, l.result, l.auction_id FROM lots l WHERE l.id = $1', [req.params.id]);
  if (!before) return notFound(res, 'This lot');
  const to = back(req, '/admin/results');
  if (!decision) { req.flash('error', 'Choose Award or Reject.'); return res.redirect(to); }
  if (before.result === decision) { req.flash('info', `Lot ${before.lot_no} is already ${label('result', decision).toLowerCase()}.`); return res.redirect(to); }
  const lot = await bidding.decideLot(before.id, decision, note);
  if (!lot) {
    req.flash('error', `Lot ${before.lot_no} cannot be decided: it is still open or has no valid bids.`);
    return res.redirect(to);
  }
  audit(req, `lot.${decision === 'awarded' ? 'award' : 'reject'}`, `lot #${before.id} (auction #${before.auction_id}, lot ${before.lot_no})${before.result !== 'pending' ? ` changed from ${before.result}` : ''}${note ? ': ' + note : ''}`);
  req.flash('ok', decision === 'awarded' ? `Lot ${before.lot_no} awarded. The winning bidder has been emailed.` : `Lot ${before.lot_no} rejected.`);
  res.redirect(to);
}));

router.get('/lots/:id(\\d+)', wrap(async (req, res) => {
  const lot = await db.one(`${RESULT_SELECT} WHERE l.id = $1`, [req.params.id]);
  if (!lot) return notFound(res, 'This lot');
  const full = await db.one(
    `SELECT l.*, ${bidding.PHASE_SQL} AS phase, a.title AS auction_title, a.show_highest_bid, a.auto_award
       FROM lots l JOIN auctions a ON a.id = l.auction_id WHERE l.id = $1`, [lot.id]
  );
  // Best bid of each bidder, top 3: the winner and the runners-up.
  const ranking = await db.many(
    `SELECT DISTINCT ON (b.user_id) b.id, b.user_id, b.amount, b.created_at, u.name, u.company_name, u.phone, u.email
       FROM bids b JOIN users u ON u.id = b.user_id
      WHERE b.lot_id = $1 AND NOT b.cancelled
      ORDER BY b.user_id, b.amount DESC, b.id ASC`, [lot.id]
  );
  ranking.sort((x, y) => y.amount - x.amount || x.id - y.id);
  const bids = await db.many(
    `SELECT b.*, u.name, u.company_name FROM bids b JOIN users u ON u.id = b.user_id WHERE b.lot_id = $1 ORDER BY b.id DESC LIMIT 200`, [lot.id]
  );
  const photos = await lotPhotos(lot.id);
  res.adminPage('admin/lot', { title: `Lot ${lot.lot_no}: ${lot.title}`, lot, full, photos, top3: ranking.slice(0, 3), bidders: ranking.length, bids, serverNow: Date.now() });
}));

router.get('/auctions/:id(\\d+)/results.csv', wrap(async (req, res) => {
  const a = await db.one('SELECT id, title FROM auctions WHERE id = $1', [req.params.id]);
  if (!a) return res.status(404).end();
  const rows = await db.many(`${RESULT_SELECT} WHERE a.id = $1 ORDER BY l.lot_no`, [a.id]);
  const out = [['Lot no', 'Lot', 'Quantity', 'Unit', 'Status', 'Result', 'Bids', 'Highest bid (INR)', 'Total value (INR)', 'Reserve (INR)', 'Reserve met',
    'Bidder no', 'Bidder', 'Company', 'Phone', 'Email', 'Closed at (IST)', 'Decision note']];
  for (const r of rows) {
    out.push([r.lot_no, r.title, r.quantity, r.unit, r.status === 'open' ? 'Open' : 'Closed', r.result ? label('result', r.result) : '', r.bid_count,
      r.amount ?? '', r.amount ? Math.round(r.amount * r.quantity * 100) / 100 : '', r.reserve_price ?? '',
      r.reserve_price === null ? 'No reserve' : r.amount === null ? '' : r.amount >= r.reserve_price ? 'Yes' : 'No',
      r.user_id ? bidderNo(r.user_id) : '', r.name || '', r.company_name || '', r.phone || '', r.email || '',
      r.status === 'closed' ? fmtDT(r.ends_at) : '', r.result_note]);
  }
  audit(req, 'auction.export_results', `#${a.id}`);
  sendCsv(res, `results-auction-${a.id}.csv`, out);
}));

module.exports = router;
