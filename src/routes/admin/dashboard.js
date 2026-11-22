const express = require('express');
const db = require('../../db');
const mailer = require('../../lib/mailer');
const razorpay = require('../../lib/razorpay');
const { PHASE_SQL } = require('../../lib/bidding');
const { wrap } = require('../../middleware');
const { integrations } = require('./integrations');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const stats = await db.one(
    `SELECT
       (SELECT count(*)::int FROM auctions a WHERE (${PHASE_SQL}) = 'live') AS live,
       (SELECT count(*)::int FROM auctions a WHERE (${PHASE_SQL}) = 'upcoming') AS upcoming,
       (SELECT count(*)::int FROM users WHERE kyc_status = 'pending') AS pending_kyc,
       (SELECT count(*)::int FROM lots WHERE result = 'pending') AS pending_results,
       (SELECT count(*)::int FROM users) AS bidders,
       (SELECT COALESCE(sum(amount), 0) FROM payments WHERE status = 'paid'
          AND paid_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS fee_month,
       (SELECT count(*)::int FROM enquiries WHERE NOT handled) AS open_enquiries,
       (SELECT count(*)::int FROM email_log WHERE status = 'failed' AND created_at > now() - interval '24 hours') AS failed_mail`
  );

  const live = await db.many(
    `SELECT a.id, a.title, s.name AS seller_name,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id AND l.status = 'open') AS lots_open,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id) AS lot_count,
            (SELECT count(*)::int FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.auction_id = a.id AND NOT b.cancelled) AS bid_count,
            (SELECT max(b.created_at) FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.auction_id = a.id) AS last_bid_at,
            (SELECT max(l.ends_at) FROM lots l WHERE l.auction_id = a.id AND l.status = 'open') AS closes_at,
            busy.lot_no AS busy_lot_no, busy.n AS busy_bids
       FROM auctions a
       LEFT JOIN sellers s ON s.id = a.seller_id
       LEFT JOIN LATERAL (SELECT l.lot_no, count(b.id)::int AS n FROM lots l JOIN bids b ON b.lot_id = l.id AND NOT b.cancelled
                           WHERE l.auction_id = a.id GROUP BY l.lot_no ORDER BY n DESC, l.lot_no LIMIT 1) busy ON true
      WHERE (${PHASE_SQL}) = 'live'
      ORDER BY closes_at`
  );

  const upcoming = await db.many(
    `SELECT a.id, a.title, a.starts_at, a.ends_at, a.announced_at, s.name AS seller_name,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id) AS lot_count
       FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id
      WHERE (${PHASE_SQL}) = 'upcoming' ORDER BY a.starts_at LIMIT 8`
  );

  const bids = await db.many(
    `SELECT b.id, b.amount, b.created_at, b.cancelled, l.id AS lot_id, l.lot_no, l.title AS lot_title,
            a.id AS auction_id, a.title AS auction_title, u.id AS user_id, u.name, u.company_name
       FROM bids b JOIN lots l ON l.id = b.lot_id JOIN auctions a ON a.id = l.auction_id JOIN users u ON u.id = b.user_id
      ORDER BY b.id DESC LIMIT 10`
  );

  const transport = mailer.transportName();
  const attention = [];
  if (stats.pending_kyc) attention.push({ text: `${stats.pending_kyc} bidder${stats.pending_kyc === 1 ? ' has' : 's have'} submitted documents for review.`, href: '/admin/bidders?kyc=pending', action: 'Review documents' });
  if (stats.pending_results) attention.push({ text: `${stats.pending_results} closed lot${stats.pending_results === 1 ? ' is' : 's are'} waiting for an award or rejection.`, href: '/admin/results', action: 'Decide results' });
  if (stats.open_enquiries) attention.push({ text: `${stats.open_enquiries} enquir${stats.open_enquiries === 1 ? 'y has' : 'ies have'} not been handled.`, href: '/admin/enquiries', action: 'Open enquiries' });
  if (stats.failed_mail) attention.push({ text: `${stats.failed_mail} email${stats.failed_mail === 1 ? '' : 's'} failed to send in the last 24 hours.`, href: '/admin/emails/log?status=failed', action: 'View failed emails' });
  const intg = integrations();
  if (transport === 'none') attention.push({ warn: true, text: `Email is not connected, so no email leaves the system. Set ${intg.mail.envHint} on the server.`, href: '/admin/settings#integrations', action: 'Check integrations' });
  if (!razorpay.configured()) attention.push({ warn: true, text: 'Online fee payment is off because Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (and RAZORPAY_WEBHOOK_SECRET for the webhook).', href: '/admin/settings#integrations', action: 'Check integrations' });

  res.adminPage('admin/dashboard', { title: 'Dashboard', stats, live, upcoming, bids, attention });
}));

module.exports = router;
