const db = require('../db');
const settings = require('./settings');
const mailer = require('./mailer');
const { fmtINR, bidderNo } = require('./util');

/** SQL expression giving an auction's phase: draft | cancelled | upcoming | live | closed. Expects alias "a". */
const PHASE_SQL = `CASE
  WHEN a.status <> 'published' THEN a.status
  WHEN now() < a.starts_at THEN 'upcoming'
  WHEN EXISTS (SELECT 1 FROM lots x WHERE x.auction_id = a.id AND x.status = 'open') THEN 'live'
  ELSE 'closed' END`;

class BidError extends Error {}

let io = null;
const attach = (socketServer) => { io = socketServer; };

/**
 * What a bidder still has to do before bidding, driven by admin settings.
 * Returns { ok, steps: [{ key, label, done, href }] }.
 */
function eligibility(user) {
  const steps = [];
  if (settings.bool('require_email_verification')) {
    steps.push({ key: 'email', label: 'Verify your email address', done: user.email_verified, href: '/account' });
  }
  if (settings.bool('require_kyc_approval')) {
    const label = user.kyc_status === 'pending' ? 'Business documents are under review'
      : user.kyc_status === 'rejected' ? 'Resubmit your business documents'
      : 'Submit your business documents';
    steps.push({ key: 'kyc', label, done: user.kyc_status === 'approved', href: '/account/verification' });
  }
  if (settings.bool('fee_enabled')) {
    const paid = !!user.fee_paid_until && new Date(user.fee_paid_until) > new Date();
    steps.push({ key: 'fee', label: 'Pay the registration fee', done: paid, href: '/account/fee' });
  }
  const blocked = !!user.blocked;
  return { ok: !blocked && steps.every((s) => s.done), blocked, steps };
}

/** Highest live bid on a lot (earliest wins a tie). */
const topBid = (q, lotId) => q.query(
  'SELECT id, user_id, amount FROM bids WHERE lot_id = $1 AND NOT cancelled ORDER BY amount DESC, id ASC LIMIT 1', [lotId]
).then((r) => r.rows[0] || null);

/**
 * Lot state for an auction, as one bidder is allowed to see it.
 * userId may be null (visitor). Other bidders' identities are never included.
 */
async function auctionState(auctionId, userId) {
  const a = await db.one(`SELECT a.id, a.show_highest_bid, a.starts_at, ${PHASE_SQL} AS phase FROM auctions a WHERE a.id = $1`, [auctionId]);
  if (!a) return null;
  const lots = await db.many(
    `SELECT l.id, l.lot_no, l.start_price, l.increment, l.ends_at, l.status, l.result,
            t.amount AS top_amount, t.user_id AS top_user,
            (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled) AS bid_count,
            (SELECT max(amount) FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled AND b.user_id = $2) AS my_amount
       FROM lots l
       LEFT JOIN LATERAL (SELECT amount, user_id FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled
                           ORDER BY amount DESC, id ASC LIMIT 1) t ON true
      WHERE l.auction_id = $1 ORDER BY l.lot_no`, [auctionId, userId || 0]
  );
  return {
    now: Date.now(),
    phase: a.phase,
    startsAt: new Date(a.starts_at).getTime(),
    lots: lots.map((l) => {
      const leading = !!userId && l.top_user === userId;
      const showTop = a.show_highest_bid || leading;
      return {
        id: l.id,
        status: l.status,
        result: l.result,
        endsAt: new Date(l.ends_at).getTime(),
        bids: l.bid_count,
        highest: showTop ? l.top_amount : null,
        // when the highest bid is hidden, bidders still need a floor to bid against
        minBid: showTop || l.top_amount === null
          ? (l.top_amount === null ? l.start_price : round2(l.top_amount + l.increment))
          : round2(Math.max(l.start_price, (l.my_amount || 0) + l.increment)),
        myBid: l.my_amount,
        leading,
      };
    }),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Tell everyone watching an auction to refresh a lot. Payload carries no bidder identity. */
function broadcastLot(auctionId, lotId) {
  if (io) io.to('auction:' + auctionId).emit('lot', { lotId });
}

const lastOutbidMail = new Map(); // `${lotId}:${userId}` -> timestamp, to avoid a mail per bid in a bidding war

/**
 * Place a bid. All checks run inside one transaction holding a row lock on the lot,
 * so two bids arriving together are serialised and the second is validated against the first.
 * Throws BidError with a message safe to show the bidder.
 */
async function placeBid({ userId, lotId, amount, ip }) {
  if (!Number.isFinite(amount) || amount <= 0) throw new BidError('Enter a valid bid amount.');

  const out = await db.tx(async (c) => {
    const lot = (await c.query(
      `SELECT l.*, a.status AS a_status, a.starts_at, a.extend_window_min, a.extend_by_min, a.title AS a_title,
              now() AS db_now
         FROM lots l JOIN auctions a ON a.id = l.auction_id
        WHERE l.id = $1 FOR UPDATE OF l`, [lotId]
    )).rows[0];
    if (!lot || lot.a_status !== 'published') throw new BidError('This lot is not open for bidding.');
    const now = new Date(lot.db_now);
    if (now < new Date(lot.starts_at)) throw new BidError('Bidding has not started yet.');
    if (lot.status !== 'open' || now >= new Date(lot.ends_at)) throw new BidError('Bidding on this lot has closed.');

    const user = (await c.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (!user) throw new BidError('Sign in to bid.');
    const el = eligibility(user);
    if (el.blocked) throw new BidError('Your account is suspended. Contact support.');
    if (!el.ok) throw new BidError('Complete your registration before bidding.');

    const top = await topBid(c, lotId);
    const min = top ? round2(top.amount + lot.increment) : lot.start_price;
    if (amount < min) throw new BidError(`Your bid must be at least ${fmtINR(min)}.`);
    const jump = settings.num('max_bid_jump_percent');
    if (jump > 0 && amount > round2(min * (1 + jump / 100))) {
      throw new BidError(`That is more than ${jump}% above the minimum bid of ${fmtINR(min)}. Check the amount and try again.`);
    }

    const bid = (await c.query(
      'INSERT INTO bids(lot_id, user_id, amount, ip) VALUES($1,$2,$3,$4) RETURNING id, created_at',
      [lotId, userId, amount, ip || '']
    )).rows[0];

    // Auto-extend: a late bid pushes the close out so others can respond.
    let extended = false;
    const msLeft = new Date(lot.ends_at) - now;
    if (lot.extend_by_min > 0 && msLeft <= lot.extend_window_min * 60000) {
      await c.query(
        `UPDATE lots SET ends_at = GREATEST(ends_at, now() + make_interval(mins => $2)) WHERE id = $1`,
        [lotId, lot.extend_by_min]
      );
      extended = true;
    }
    return { lot, bid, prevTop: top, extended };
  });

  broadcastLot(out.lot.auction_id, lotId);

  // Tell the bidder who just lost the lead (at most one mail per lot every 10 minutes).
  const prev = out.prevTop;
  if (prev && prev.user_id !== userId) {
    if (io) io.to('user:' + prev.user_id).emit('outbid', { lotId, lotNo: out.lot.lot_no });
    const k = `${lotId}:${prev.user_id}`;
    if (Date.now() - (lastOutbidMail.get(k) || 0) > 10 * 60000) {
      lastOutbidMail.set(k, Date.now());
      db.one('SELECT name, email, email_opt_out FROM users WHERE id = $1', [prev.user_id]).then((u) => {
        if (u && !u.email_opt_out) {
          return mailer.send('outbid', u.email, {
            name: u.name, auction_title: out.lot.a_title, lot_no: out.lot.lot_no, lot_title: out.lot.title,
            your_bid: fmtINR(prev.amount), auction_url: mailer.url('/auctions/' + out.lot.auction_id),
          });
        }
      }).catch((e) => console.error('outbid mail', e.message));
    }
  }
  return { bidId: out.bid.id, extended: out.extended };
}

/**
 * Close every lot whose time is up. Safe to call from several processes:
 * the UPDATE ... RETURNING claims each lot exactly once.
 */
async function closeDueLots() {
  const closed = await db.many(
    `UPDATE lots l SET status = 'closed'
       FROM auctions a
      WHERE a.id = l.auction_id AND a.status = 'published' AND l.status = 'open' AND l.ends_at <= now()
  RETURNING l.id, l.auction_id, l.reserve_price, a.auto_award`
  );
  for (const lot of closed) {
    try {
      const top = await topBid(db.pool, lot.id);
      if (!top) {
        await db.query(`UPDATE lots SET result = 'no_bids' WHERE id = $1`, [lot.id]);
      } else {
        const meetsReserve = lot.reserve_price === null || top.amount >= lot.reserve_price;
        const award = lot.auto_award && meetsReserve;
        await db.query('UPDATE lots SET result = $2, winning_bid_id = $3 WHERE id = $1', [lot.id, award ? 'awarded' : 'pending', top.id]);
        if (award) await notifyWinner(lot.id);
      }
    } catch (e) {
      console.error('closing lot', lot.id, e.message);
    }
    broadcastLot(lot.auction_id, lot.id);
  }
  return closed.length;
}

/** Record the admin's decision on a closed lot. decision: 'awarded' | 'rejected'. */
async function decideLot(lotId, decision, note) {
  const lot = await db.one(
    `UPDATE lots SET result = $2, result_note = $3
      WHERE id = $1 AND status = 'closed' AND winning_bid_id IS NOT NULL AND result IN ('pending','awarded','rejected')
  RETURNING id, auction_id, result`, [lotId, decision, note || '']
  );
  if (!lot) return null;
  if (decision === 'awarded') await notifyWinner(lotId);
  broadcastLot(lot.auction_id, lotId);
  return lot;
}

async function notifyWinner(lotId) {
  const w = await db.one(
    `SELECT u.name, u.email, b.amount, l.lot_no, l.title AS lot_title, l.quantity, l.unit, a.title AS a_title, a.id AS auction_id
       FROM lots l JOIN bids b ON b.id = l.winning_bid_id JOIN users u ON u.id = b.user_id JOIN auctions a ON a.id = l.auction_id
      WHERE l.id = $1`, [lotId]
  );
  if (!w) return;
  await mailer.send('lot_won', w.email, {
    name: w.name, auction_title: w.a_title, lot_no: w.lot_no, lot_title: w.lot_title,
    quantity: `${w.quantity} ${w.unit}`, winning_bid: fmtINR(w.amount), account_url: mailer.url('/account/bids'),
  });
}

/**
 * Cancel a bid (admin action, e.g. an obvious typing mistake). If the lot already closed
 * with this bid as the winner, the next highest bid takes its place.
 */
async function cancelBid(bidId, note) {
  const res = await db.tx(async (c) => {
    const bid = (await c.query('SELECT b.*, l.auction_id, l.winning_bid_id, l.status AS lot_status FROM bids b JOIN lots l ON l.id = b.lot_id WHERE b.id = $1 FOR UPDATE OF b', [bidId])).rows[0];
    if (!bid || bid.cancelled) return null;
    await c.query('UPDATE bids SET cancelled = true, cancel_note = $2 WHERE id = $1', [bidId, note || '']);
    if (bid.lot_status === 'closed' && Number(bid.winning_bid_id) === Number(bid.id)) {
      const next = await topBid(c, bid.lot_id);
      await c.query('UPDATE lots SET winning_bid_id = $2, result = $3 WHERE id = $1', [bid.lot_id, next ? next.id : null, next ? 'pending' : 'no_bids']);
    }
    return bid;
  });
  if (res) broadcastLot(res.auction_id, res.lot_id);
  return res;
}

/** Before an auction starts, (re)compute each lot's closing time from the auction window and stagger. */
async function recalcLotEnds(auctionId) {
  await db.query(
    `UPDATE lots l SET ends_at = a.ends_at + make_interval(mins => (a.stagger_min * (rn - 1))::int)
       FROM auctions a, (SELECT id, row_number() OVER (ORDER BY lot_no) AS rn FROM lots WHERE auction_id = $1) o
      WHERE a.id = $1 AND l.auction_id = a.id AND o.id = l.id AND l.status = 'open' AND now() < a.starts_at`, [auctionId]
  );
}

module.exports = {
  PHASE_SQL, BidError, attach, eligibility, auctionState, placeBid, closeDueLots,
  decideLot, cancelBid, recalcLotEnds, broadcastLot, bidderNo,
};
