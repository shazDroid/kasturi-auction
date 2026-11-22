const db = require('../db');
const settings = require('./settings');
const mailer = require('./mailer');
const bidding = require('./bidding');
const { fmtDT } = require('./util');

/** Bidders who should receive auction announcements and reminders. */
const audience = () => db.many(
  `SELECT id, name, email FROM users WHERE NOT blocked AND NOT email_opt_out AND email_verified`
);

/** Email every bidder about an auction, using the given template. Returns the number queued. */
async function mailAuction(templateKey, auctionId) {
  const a = await db.one(
    `SELECT a.*, s.name AS seller_name, (SELECT count(*)::int FROM lots WHERE auction_id = a.id) AS lot_count
       FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id WHERE a.id = $1`, [auctionId]
  );
  if (!a) return 0;
  const users = await audience();
  for (const u of users) {
    await mailer.send(templateKey, u.email, {
      name: u.name, auction_title: a.title, seller_name: a.seller_name || '', location: a.location,
      starts_at: fmtDT(a.starts_at), ends_at: fmtDT(a.ends_at), lot_count: a.lot_count,
      auction_url: mailer.url('/auctions/' + a.id),
    });
  }
  return users.length;
}

async function sendReminders() {
  const lead = settings.num('reminder_minutes_before');
  if (lead <= 0) return;
  // Claim first, then send, so a restart can't send the same reminder twice.
  const due = await db.many(
    `UPDATE auctions SET reminder_sent = true
      WHERE status = 'published' AND NOT reminder_sent AND starts_at > now()
        AND starts_at <= now() + make_interval(mins => $1) RETURNING id`, [lead]
  );
  for (const a of due) await mailAuction('auction_reminder', a.id);
}

function loop(name, fn, everyMs) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { console.error(`[worker:${name}]`, e.message); }
    running = false;
  }, everyMs).unref();
}

function start() {
  loop('close-lots', bidding.closeDueLots, 2000);
  loop('mail-queue', mailer.processQueue, 5000);
  loop('reminders', sendReminders, 60000);
}

module.exports = { start, mailAuction, audience };
