const db = require('../db');
const settings = require('./settings');
const mailer = require('./mailer');
const razorpay = require('./razorpay');
const { fmtINR, fmtDate, bidderNo } = require('./util');

const round2 = (n) => Math.round(n * 100) / 100;

/** Current registration fee from admin settings: { base, tax, total, gstPercent, validityDays }. */
function feeQuote() {
  const base = round2(settings.num('fee_amount'));
  const gstPercent = settings.num('fee_gst_percent');
  const tax = round2(base * gstPercent / 100);
  return { base, tax, total: round2(base + tax), gstPercent, validityDays: settings.num('fee_validity_days') };
}

/** Whether a bidder's registration fee is currently valid. */
const feeActive = (user) => !!user.fee_paid_until && new Date(user.fee_paid_until) > new Date();

/**
 * Start an online fee payment: creates a Razorpay order and a matching 'created' payment row.
 * Returns { payment, order } where order.id goes to Razorpay Checkout.
 */
async function createFeeOrder(user) {
  const q = feeQuote();
  if (q.total <= 0) throw new Error('Registration fee is not configured');
  const order = await razorpay.createOrder({
    amountPaise: Math.round(q.total * 100),
    receipt: `fee-${user.id}-${Date.now()}`,
    notes: { user_id: String(user.id), bidder_no: bidderNo(user.id), purpose: 'registration_fee' },
  });
  const payment = await db.one(
    `INSERT INTO payments(user_id, base_amount, tax_amount, amount, method, status, rp_order_id)
     VALUES($1,$2,$3,$4,'razorpay','created',$5) RETURNING *`,
    [user.id, q.base, q.tax, q.total, order.id]
  );
  return { payment, order };
}

/**
 * Mark a payment paid and activate the bidder's fee. Idempotent: the checkout callback and the
 * Razorpay webhook can both call this for the same order and the fee is only applied once.
 * Returns the payment row, or null if the order is unknown.
 */
async function markPaidByOrder(rpOrderId, rpPaymentId) {
  const result = await db.tx(async (c) => {
    const p = (await c.query('SELECT * FROM payments WHERE rp_order_id = $1 FOR UPDATE', [rpOrderId])).rows[0];
    if (!p) return null;
    if (p.status === 'paid') return { payment: p, fresh: false };
    const paid = (await c.query(
      `UPDATE payments SET status = 'paid', rp_payment_id = $2, paid_at = now() WHERE id = $1 RETURNING *`,
      [p.id, rpPaymentId || '']
    )).rows[0];
    await applyFee(c, p.user_id);
    return { payment: paid, fresh: true };
  });
  if (result && result.fresh) await sendReceipt(result.payment.id);
  return result ? result.payment : null;
}

/** Record a fee received outside the gateway (NEFT, cheque, cash). Admin action. */
async function recordOffline(userId, note) {
  const q = feeQuote();
  const payment = await db.tx(async (c) => {
    const p = (await c.query(
      `INSERT INTO payments(user_id, base_amount, tax_amount, amount, method, status, note, paid_at)
       VALUES($1,$2,$3,$4,'offline','paid',$5, now()) RETURNING *`,
      [userId, q.base, q.tax, q.total, note || '']
    )).rows[0];
    await applyFee(c, userId);
    return p;
  });
  await sendReceipt(payment.id);
  return payment;
}

/** Extend the bidder's fee validity from today, or from the current expiry if it is still running. */
async function applyFee(c, userId) {
  const days = settings.num('fee_validity_days');
  if (days <= 0) {
    await c.query(`UPDATE users SET fee_paid_until = '2999-12-31' WHERE id = $1`, [userId]);
  } else {
    await c.query(
      `UPDATE users SET fee_paid_until = GREATEST(COALESCE(fee_paid_until, now()), now()) + make_interval(days => $2) WHERE id = $1`,
      [userId, days]
    );
  }
}

/** Remove a bidder's fee validity (admin action, e.g. after a refund). */
const revokeFee = (userId) => db.query('UPDATE users SET fee_paid_until = NULL WHERE id = $1', [userId]);

const validUntilText = (d) => (!d ? '' : new Date(d).getFullYear() > 2900 ? 'No expiry' : fmtDate(d));

async function sendReceipt(paymentId) {
  const r = await db.one(
    `SELECT p.*, u.name, u.email, u.company_name, u.fee_paid_until FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [paymentId]
  );
  if (!r) return;
  const vars = {
    name: r.name, company: r.company_name, base_amount: fmtINR(r.base_amount), tax_amount: fmtINR(r.tax_amount),
    amount: fmtINR(r.amount), payment_ref: r.rp_payment_id || `OFFLINE-${r.id}`, paid_on: fmtDate(r.paid_at),
    valid_until: validUntilText(r.fee_paid_until),
  };
  await mailer.send('fee_receipt', r.email, vars);
  await mailer.notifyAdmin('fee_paid_admin', { bidder_name: r.name, company: r.company_name, amount: vars.amount, payment_ref: vars.payment_ref });
}

module.exports = { feeQuote, feeActive, createFeeOrder, markPaidByOrder, recordOffline, revokeFee, validUntilText };
