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

/**
 * SQL condition: may the bidder whose id is bound to parameter $n see auction "a"?
 * Bind 0 for a visitor. Public auctions are visible to everyone; restricted ones only to bidders
 * in one of the auction's groups or invited individually. Use it in every public query:
 *   `... WHERE a.status = 'published' AND ${visibleSql(1)}`, [userId || 0]
 */
const visibleSql = (n) => `(a.visibility <> 'restricted'
  OR EXISTS (SELECT 1 FROM auction_groups ag JOIN users vu ON vu.group_id = ag.group_id WHERE ag.auction_id = a.id AND vu.id = $${n})
  OR EXISTS (SELECT 1 FROM auction_invites ai WHERE ai.auction_id = a.id AND ai.user_id = $${n}))`;

/** True when this bidder (or visitor, userId null) may see the auction. */
async function canSee(auctionId, userId) {
  return !!(await db.one(`SELECT 1 FROM auctions a WHERE a.id = $2 AND ${visibleSql(1)}`, [userId || 0, auctionId]));
}

class BidError extends Error {}

let io = null;
const attach = (socketServer) => { io = socketServer; };
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * What a bidder still has to do before bidding, driven by admin settings.
 * Returns { ok, blocked, steps: [{ key, label, done, href }] }.
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

/** The start price this bidder's group gets on a lot (falls back to the lot's own start price). */
async function startPriceFor(q, lot, groupId) {
  if (!groupId) return lot.start_price;
  const r = await q.query('SELECT start_price FROM lot_group_prices WHERE lot_id = $1 AND group_id = $2', [lot.id, groupId]);
  return r.rows[0] ? r.rows[0].start_price : lot.start_price;
}

/** Buyer's commission rate for a bidder: their group's rate, else the default from Settings. */
async function commissionFor(q, userId) {
  const r = await q.query('SELECT g.commission_percent FROM users u LEFT JOIN bidder_groups g ON g.id = u.group_id WHERE u.id = $1', [userId]);
  const own = r.rows[0] ? r.rows[0].commission_percent : null;
  return own === null || own === undefined ? settings.num('default_commission_percent') : own;
}

/**
 * Lot state for an auction, as one bidder is allowed to see it.
 * userId may be null (visitor). Other bidders' identities and maximums are never included.
 * The caller is responsible for checking canSee() first.
 */
async function auctionState(auctionId, userId) {
  const a = await db.one(`SELECT a.id, a.show_highest_bid, a.starts_at, ${PHASE_SQL} AS phase FROM auctions a WHERE a.id = $1`, [auctionId]);
  if (!a) return null;
  const lots = await db.many(
    `SELECT l.id, l.lot_no, COALESCE(gp.start_price, l.start_price) AS start_price, l.increment, l.ends_at, l.status, l.result,
            l.winning_bid_id, t.id AS top_id, t.amount AS top_amount, t.user_id AS top_user,
            (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled) AS bid_count,
            (SELECT max(amount) FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled AND b.user_id = $2) AS my_amount,
            (SELECT max_amount FROM proxy_bids p WHERE p.lot_id = l.id AND p.user_id = $2 AND p.active) AS my_max
       FROM lots l
       LEFT JOIN users me ON me.id = $2
       LEFT JOIN lot_group_prices gp ON gp.lot_id = l.id AND gp.group_id = me.group_id
       LEFT JOIN LATERAL (SELECT id, amount, user_id FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled
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
      const floor = l.top_amount === null ? l.start_price : Math.max(l.start_price, round2(l.top_amount + l.increment));
      return {
        id: l.id,
        status: l.status,
        result: l.result,
        endsAt: new Date(l.ends_at).getTime(),
        bids: l.bid_count,
        startPrice: l.start_price,
        highest: showTop ? l.top_amount : null,
        // when the highest bid is hidden, bidders still need a floor to bid against
        minBid: showTop || l.top_amount === null ? floor : round2(Math.max(l.start_price, (l.my_amount || 0) + l.increment)),
        myBid: l.my_amount,
        myMax: l.my_max,
        leading,
        won: !!userId && l.result === 'awarded' && l.top_user === userId && Number(l.winning_bid_id) === Number(l.top_id),
      };
    }),
  };
}

/** Tell everyone watching an auction to refresh a lot. Payload carries no bidder identity. */
function broadcastLot(auctionId, lotId) {
  if (io) io.to('auction:' + auctionId).emit('lot', { lotId });
}

/** Load and lock a lot for bidding, and check that the bidder may bid on it now. */
async function lockLotForBid(c, lotId, userId) {
  const lot = (await c.query(
    `SELECT l.*, a.status AS a_status, a.starts_at, a.extend_window_min, a.extend_by_min, a.title AS a_title,
            a.visibility, now() AS db_now
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
  if (lot.visibility === 'restricted') {
    const ok = (await c.query(`SELECT 1 FROM auctions a WHERE a.id = $2 AND ${visibleSql(1)}`, [userId, lot.auction_id])).rows[0];
    if (!ok) throw new BidError('This lot is not open for bidding.');
  }
  return { lot, user, now };
}

const insertBid = (c, lotId, userId, amount, ip, auto) => c.query(
  'INSERT INTO bids(lot_id, user_id, amount, ip, auto) VALUES($1,$2,$3,$4,$5) RETURNING id', [lotId, userId, amount, ip || '', !!auto]
).then((r) => r.rows[0].id);

/**
 * Auto-bidding. Runs inside the bid transaction, after any new bid or new maximum, while the lot
 * row is locked. Each bidder with an active maximum who is not leading bids the smallest amount
 * that takes the lead, as long as it is within their maximum. When two maximums compete, the lower
 * one is bid in full and the higher one answers one increment above it (or at its own maximum).
 * If two maximums are equal the earlier one keeps the lead. Returns how many bids were placed.
 */
async function resolveProxies(c, lot) {
  let placed = 0;
  for (let guard = 0; guard < 40; guard++) {
    const top = await topBid(c, lot.id);
    const proxies = (await c.query(
      `SELECT p.user_id, p.max_amount, COALESCE(gp.start_price, $2::numeric) AS start_price
         FROM proxy_bids p JOIN users u ON u.id = p.user_id AND NOT u.blocked
         LEFT JOIN lot_group_prices gp ON gp.lot_id = p.lot_id AND gp.group_id = u.group_id
        WHERE p.lot_id = $1 AND p.active ORDER BY p.max_amount DESC, p.updated_at ASC, p.id ASC`, [lot.id, lot.start_price]
    )).rows;
    const need = (p) => (top ? Math.max(p.start_price, round2(top.amount + lot.increment)) : p.start_price);
    const challenger = proxies.find((p) => (!top || p.user_id !== top.user_id) && p.max_amount >= need(p));
    if (!challenger) break;
    const holder = top ? proxies.find((p) => p.user_id === top.user_id) : null;

    if (holder && holder.max_amount > top.amount) {
      // Two maximums compete: settle it in at most two bids.
      if (challenger.max_amount > holder.max_amount) {
        await insertBid(c, lot.id, holder.user_id, holder.max_amount, 'auto', true);
        await insertBid(c, lot.id, challenger.user_id, Math.min(challenger.max_amount, Math.max(challenger.start_price, round2(holder.max_amount + lot.increment))), 'auto', true);
        placed += 2;
      } else if (challenger.max_amount < holder.max_amount) {
        await insertBid(c, lot.id, challenger.user_id, challenger.max_amount, 'auto', true);
        await insertBid(c, lot.id, holder.user_id, Math.min(holder.max_amount, round2(challenger.max_amount + lot.increment)), 'auto', true);
        placed += 2;
      } else {
        await insertBid(c, lot.id, holder.user_id, holder.max_amount, 'auto', true); // equal: earlier maximum keeps the lead
        placed += 1;
      }
    } else {
      await insertBid(c, lot.id, challenger.user_id, need(challenger), 'auto', true);
      placed += 1;
    }
  }
  return placed;
}

/** A bid in the closing window pushes the close out so others can respond. */
async function maybeExtend(c, lot, now) {
  const msLeft = new Date(lot.ends_at) - now;
  if (lot.extend_by_min > 0 && msLeft <= lot.extend_window_min * 60000) {
    await c.query('UPDATE lots SET ends_at = GREATEST(ends_at, now() + make_interval(mins => $2)) WHERE id = $1', [lot.id, lot.extend_by_min]);
    return true;
  }
  return false;
}

const lastOutbidMail = new Map(); // `${lotId}:${userId}` -> timestamp, to avoid a mail per bid in a bidding war

/** After a committed change: refresh watchers and tell bidders who lost the lead. */
function afterBids(lot, prevTop, finalTop, touchedUserIds) {
  broadcastLot(lot.auction_id, lot.id);
  const losers = new Set(touchedUserIds);
  if (prevTop) losers.add(prevTop.user_id);
  if (finalTop) losers.delete(finalTop.user_id);
  for (const uid of losers) {
    if (io) io.to('user:' + uid).emit('outbid', { lotId: lot.id, lotNo: lot.lot_no });
    const k = `${lot.id}:${uid}`;
    if (Date.now() - (lastOutbidMail.get(k) || 0) < 10 * 60000) continue;
    lastOutbidMail.set(k, Date.now());
    db.one(`SELECT u.name, u.email, (SELECT max(amount) FROM bids WHERE lot_id = $2 AND user_id = u.id AND NOT cancelled) AS amount
              FROM users u WHERE u.id = $1`, [uid, lot.id]).then((u) => {
      if (!u || u.amount === null) return null;
      return mailer.send('outbid', u.email, {
        name: u.name, auction_title: lot.a_title, lot_no: lot.lot_no, lot_title: lot.title,
        your_bid: fmtINR(u.amount), auction_url: mailer.url(`/auctions/${lot.auction_id}/lots/${lot.id}`),
      });
    }).catch((e) => console.error('outbid mail', e.message));
  }
}

/**
 * Place a bid. All checks run inside one transaction holding a row lock on the lot, so two bids
 * arriving together are serialised and the second is validated against the first. Other bidders'
 * auto-bids respond inside the same transaction.
 * Returns { bidId, extended, leading }: leading is false when an auto-bid immediately beat this bid.
 * Throws BidError with a message safe to show the bidder.
 */
async function placeBid({ userId, lotId, amount, ip }) {
  if (!Number.isFinite(amount) || amount <= 0) throw new BidError('Enter a valid bid amount.');

  const out = await db.tx(async (c) => {
    const { lot, user, now } = await lockLotForBid(c, lotId, userId);
    const top = await topBid(c, lotId);
    const start = await startPriceFor(c, lot, user.group_id);
    const min = top ? Math.max(start, round2(top.amount + lot.increment)) : start;
    if (amount < min) throw new BidError(`Your bid must be at least ${fmtINR(min)}.`);
    const jump = settings.num('max_bid_jump_percent');
    if (jump > 0 && amount > round2(min * (1 + jump / 100))) {
      throw new BidError(`That is more than ${jump}% above the minimum bid of ${fmtINR(min)}. Check the amount and try again.`);
    }

    const bidId = await insertBid(c, lotId, userId, amount, ip, false);
    // A manual bid above the bidder's own maximum replaces that maximum.
    await c.query('UPDATE proxy_bids SET active = false, updated_at = now() WHERE lot_id = $1 AND user_id = $2 AND max_amount < $3', [lotId, userId, amount]);
    await resolveProxies(c, lot);
    const extended = await maybeExtend(c, lot, now);
    const finalTop = await topBid(c, lotId);
    return { lot, bidId, prevTop: top, finalTop, extended };
  });

  afterBids(out.lot, out.prevTop, out.finalTop, [userId]);
  return { bidId: out.bidId, extended: out.extended, leading: !!out.finalTop && out.finalTop.user_id === userId };
}

/**
 * Set or raise a bidder's auto-bid maximum on a lot. The system then bids for them, one increment
 * at a time, only as far as needed to stay in the lead. Returns { extended, leading, max }.
 */
async function setProxy({ userId, lotId, maxAmount }) {
  if (!settings.bool('proxy_bidding_enabled')) throw new BidError('Auto-bidding is not available.');
  if (!Number.isFinite(maxAmount) || maxAmount <= 0) throw new BidError('Enter a valid maximum amount.');

  const out = await db.tx(async (c) => {
    const { lot, user, now } = await lockLotForBid(c, lotId, userId);
    const top = await topBid(c, lotId);
    const start = await startPriceFor(c, lot, user.group_id);
    const leading = !!top && top.user_id === userId;
    const min = leading ? top.amount : (top ? Math.max(start, round2(top.amount + lot.increment)) : start);
    if (maxAmount < min) {
      throw new BidError(leading ? `Your maximum cannot be below your current bid of ${fmtINR(min)}.` : `Your maximum must be at least ${fmtINR(min)}.`);
    }
    await c.query(
      `INSERT INTO proxy_bids(lot_id, user_id, max_amount) VALUES($1,$2,$3)
       ON CONFLICT (lot_id, user_id) DO UPDATE SET max_amount = EXCLUDED.max_amount, active = true, updated_at = now()`,
      [lotId, userId, maxAmount]
    );
    const placed = await resolveProxies(c, lot);
    const extended = placed > 0 ? await maybeExtend(c, lot, now) : false;
    const finalTop = await topBid(c, lotId);
    return { lot, prevTop: top, finalTop, extended };
  });

  afterBids(out.lot, out.prevTop, out.finalTop, [userId]);
  return { extended: out.extended, leading: !!out.finalTop && out.finalTop.user_id === userId, max: maxAmount };
}

/** Stop auto-bidding for a bidder on a lot. Bids already placed stand. */
async function cancelProxy({ userId, lotId }) {
  const r = await db.query('UPDATE proxy_bids SET active = false, updated_at = now() WHERE lot_id = $1 AND user_id = $2 AND active', [lotId, userId]);
  return r.rowCount > 0;
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
      await db.query('UPDATE proxy_bids SET active = false WHERE lot_id = $1 AND active', [lot.id]);
      const top = await topBid(db.pool, lot.id);
      if (!top) {
        await db.query(`UPDATE lots SET result = 'no_bids' WHERE id = $1`, [lot.id]);
      } else {
        const meetsReserve = lot.reserve_price === null || top.amount >= lot.reserve_price;
        const award = lot.auto_award && meetsReserve;
        await db.query('UPDATE lots SET result = $2, winning_bid_id = $3 WHERE id = $1', [lot.id, award ? 'awarded' : 'pending', top.id]);
        if (award) { await fixCommission(lot.id); await notifyWinner(lot.id); }
      }
    } catch (e) {
      console.error('closing lot', lot.id, e.message);
    }
    broadcastLot(lot.auction_id, lot.id);
  }
  return closed.length;
}

/** Freeze the buyer's commission rate on an awarded lot from the winner's group. */
async function fixCommission(lotId) {
  const w = await db.one('SELECT b.user_id FROM lots l JOIN bids b ON b.id = l.winning_bid_id WHERE l.id = $1', [lotId]);
  if (!w) return;
  await db.query('UPDATE lots SET commission_percent = $2 WHERE id = $1', [lotId, await commissionFor(db.pool, w.user_id)]);
}

/** Record the admin's decision on a closed lot. decision: 'awarded' | 'rejected'. */
async function decideLot(lotId, decision, note) {
  const lot = await db.one(
    `UPDATE lots SET result = $2, result_note = $3
      WHERE id = $1 AND status = 'closed' AND winning_bid_id IS NOT NULL AND result IN ('pending','awarded','rejected')
  RETURNING id, auction_id, result`, [lotId, decision, note || '']
  );
  if (!lot) return null;
  if (decision === 'awarded') { await fixCommission(lotId); await notifyWinner(lotId); }
  else await db.query('UPDATE lots SET commission_percent = NULL WHERE id = $1', [lotId]);
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
    // The bidder's auto-bid would simply re-place the cancelled amount, so stop it too.
    await c.query('UPDATE proxy_bids SET active = false, updated_at = now() WHERE lot_id = $1 AND user_id = $2', [bid.lot_id, bid.user_id]);
    if (bid.lot_status === 'closed' && Number(bid.winning_bid_id) === Number(bid.id)) {
      const next = await topBid(c, bid.lot_id);
      await c.query('UPDATE lots SET winning_bid_id = $2, result = $3, commission_percent = NULL WHERE id = $1', [bid.lot_id, next ? next.id : null, next ? 'pending' : 'no_bids']);
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
  PHASE_SQL, visibleSql, canSee, BidError, attach, eligibility, auctionState, placeBid, setProxy, cancelProxy,
  closeDueLots, decideLot, cancelBid, recalcLotEnds, broadcastLot, bidderNo, startPriceFor, commissionFor,
};
