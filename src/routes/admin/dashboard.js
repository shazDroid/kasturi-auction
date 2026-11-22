const express = require('express');
const db = require('../../db');
const mailer = require('../../lib/mailer');
const razorpay = require('../../lib/razorpay');
const { PHASE_SQL } = require('../../lib/bidding');
const { wrap } = require('../../middleware');
const { integrations } = require('./integrations');

const router = express.Router();

const DAY_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' });

/** A "nice" axis top for a maximum value: 1, 2, 5 or 10 times a power of ten, at least 4. */
function niceMax(max) {
  if (max <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/**
 * Geometry for a small server-rendered bar chart (inline SVG in the view, no JS).
 * rows: [{ day: 'YYYY-MM-DD', n }]. Coordinates are in a 360 x 190 viewBox, close to the rendered size so text stays legible.
 */
function barChart(rows) {
  const W = 360, H = 190, left = 28, right = 4, top = 10, bottom = 24;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = Math.max(0, ...rows.map((r) => r.n));
  const yMax = niceMax(max);
  const step = plotW / rows.length;
  const barW = Math.max(4, Math.min(18, step - 6));
  const ticks = [0, yMax / 2, yMax].map((v) => ({ v, y: top + plotH - (v / yMax) * plotH }));
  const bars = rows.map((r, i) => {
    const d = new Date(r.day + 'T00:00:00Z');
    const h = r.n ? Math.max(2, (r.n / yMax) * plotH) : 0;
    const x = left + i * step + (step - barW) / 2;
    return {
      n: r.n, x, w: barW, y: top + plotH - h, h, slotX: left + i * step, slotW: step,
      label: DAY_FMT.format(d), weekday: WEEKDAY_FMT.format(d),
      // A label every third day, counted back from today so the last bar is always labelled.
      showLabel: (rows.length - 1 - i) % 3 === 0,
      today: i === rows.length - 1,
    };
  });
  return {
    W, H, left, right, top, plotH, baseY: top + plotH, ticks, bars,
    total: rows.reduce((t, r) => t + r.n, 0), max,
    busiest: max ? bars.slice().sort((a, b) => b.n - a.n)[0] : null,
  };
}

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
       (SELECT count(*)::int FROM email_log WHERE status = 'failed' AND created_at > now() - interval '24 hours') AS failed_mail,
       (SELECT count(*)::int FROM bidder_groups) AS groups,
       (SELECT count(*)::int FROM users WHERE group_id IS NOT NULL) AS grouped_bidders,
       (SELECT count(*)::int FROM invite_codes WHERE active AND used_count < max_uses AND (expires_at IS NULL OR expires_at > now())) AS active_codes,
       (SELECT count(*)::int FROM auctions a WHERE a.visibility = 'restricted' AND (${PHASE_SQL}) IN ('live', 'upcoming')) AS restricted_open,
       (SELECT count(*)::int FROM auctions a WHERE a.visibility = 'restricted' AND (${PHASE_SQL}) IN ('live', 'upcoming', 'draft')
           AND NOT EXISTS (SELECT 1 FROM auction_groups ag WHERE ag.auction_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM auction_invites ai WHERE ai.auction_id = a.id)) AS restricted_nobody`
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
  if (stats.restricted_nobody) attention.push({ text: `${stats.restricted_nobody} restricted auction${stats.restricted_nobody === 1 ? ' has' : 's have'} no groups and no invited bidders, so nobody can see ${stats.restricted_nobody === 1 ? 'it' : 'them'}.`, href: '/admin/auctions?vis=restricted', action: 'Check restricted auctions' });
  if (stats.pending_kyc) attention.push({ text: `${stats.pending_kyc} bidder${stats.pending_kyc === 1 ? ' has' : 's have'} submitted documents for review.`, href: '/admin/bidders?kyc=pending', action: 'Review documents' });
  if (stats.pending_results) attention.push({ text: `${stats.pending_results} closed lot${stats.pending_results === 1 ? ' is' : 's are'} waiting for an award or rejection.`, href: '/admin/results', action: 'Decide results' });
  if (stats.open_enquiries) attention.push({ text: `${stats.open_enquiries} enquir${stats.open_enquiries === 1 ? 'y has' : 'ies have'} not been handled.`, href: '/admin/enquiries', action: 'Open enquiries' });
  if (stats.failed_mail) attention.push({ text: `${stats.failed_mail} email${stats.failed_mail === 1 ? '' : 's'} failed to send in the last 24 hours.`, href: '/admin/emails/log?status=failed', action: 'View failed emails' });
  const intg = integrations();
  if (transport === 'none') attention.push({ warn: true, text: `Email is not connected, so no email leaves the system. Set ${intg.mail.envHint} on the server.`, href: '/admin/settings#integrations', action: 'Check integrations' });
  if (!razorpay.configured()) attention.push({ warn: true, text: 'Online fee payment is off because Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (and RAZORPAY_WEBHOOK_SECRET for the webhook).', href: '/admin/settings#integrations', action: 'Check integrations' });

  // Activity for the last 14 IST days, today included. Days without rows come back as 0.
  const daily = (table, where) => db.many(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(x.n, 0)::int AS n
       FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 13, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') d
       LEFT JOIN (SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS n FROM ${table}
                   WHERE created_at >= now() - interval '15 days' ${where} GROUP BY 1) x ON x.day = d::date
      ORDER BY d`
  );
  const [bidDays, regDays] = await Promise.all([daily('bids', 'AND NOT cancelled'), daily('users', '')]);
  const fees = await db.one(
    `WITH m AS (SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AS this_start)
     SELECT COALESCE(sum(p.amount) FILTER (WHERE p.paid_at >= (m.this_start AT TIME ZONE 'Asia/Kolkata')), 0) AS this_month,
            count(*) FILTER (WHERE p.paid_at >= (m.this_start AT TIME ZONE 'Asia/Kolkata'))::int AS this_count,
            COALESCE(sum(p.amount) FILTER (WHERE p.paid_at >= ((m.this_start - interval '1 month') AT TIME ZONE 'Asia/Kolkata')
                                             AND p.paid_at < (m.this_start AT TIME ZONE 'Asia/Kolkata')), 0) AS last_month,
            count(*) FILTER (WHERE p.paid_at >= ((m.this_start - interval '1 month') AT TIME ZONE 'Asia/Kolkata')
                               AND p.paid_at < (m.this_start AT TIME ZONE 'Asia/Kolkata'))::int AS last_count,
            COALESCE(sum(p.amount) FILTER (WHERE p.paid_at >= ((m.this_start - interval '1 month') AT TIME ZONE 'Asia/Kolkata')
                                             AND p.paid_at < now() - interval '1 month'), 0) AS last_to_date,
            to_char(m.this_start, 'FMMonth') AS this_name, to_char(m.this_start - interval '1 month', 'FMMonth') AS last_name
       FROM m LEFT JOIN payments p ON p.status = 'paid' AND p.paid_at >= ((m.this_start - interval '1 month') AT TIME ZONE 'Asia/Kolkata')
      GROUP BY m.this_start`
  );

  res.adminPage('admin/dashboard', {
    title: 'Dashboard', stats, live, upcoming, bids, attention, fees,
    charts: [
      { id: 'bids', title: 'Bids in the last 14 days', unit: 'bid', ...barChart(bidDays), href: '/admin/auctions' },
      { id: 'regs', title: 'Registrations in the last 14 days', unit: 'registration', ...barChart(regDays), href: '/admin/bidders' },
    ],
  });
}));

module.exports = router;
