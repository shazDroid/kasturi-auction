const express = require('express');
const db = require('../../db');
const payments = require('../../lib/payments');
const razorpay = require('../../lib/razorpay');
const { clean, fmtDT, bidderNo } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { paginate, notFound, sendCsv, back } = require('./helpers');

const router = express.Router();
const STATUSES = ['paid', 'created', 'failed', 'refunded'];
const METHODS = ['razorpay', 'offline'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function filterSql(query) {
  const f = {
    status: STATUSES.includes(query.status) ? query.status : '',
    method: METHODS.includes(query.method) ? query.method : '',
    from: isDate(query.from) ? query.from : '',
    to: isDate(query.to) ? query.to : '',
    q: clean(query.q, 100),
  };
  // Dates are IST calendar days; a payment counts on the day it was paid (or created, if never paid).
  const where = `WHERE ($1 = '' OR p.status = $1) AND ($2 = '' OR p.method = $2)
    AND ($3 = '' OR COALESCE(p.paid_at, p.created_at) >= ($3 || 'T00:00:00+05:30')::timestamptz)
    AND ($4 = '' OR COALESCE(p.paid_at, p.created_at) < ($4 || 'T00:00:00+05:30')::timestamptz + interval '1 day')
    AND ($5 = '' OR u.name ILIKE '%' || $5 || '%' OR u.company_name ILIKE '%' || $5 || '%' OR u.email ILIKE '%' || $5 || '%'
         OR p.rp_order_id ILIKE '%' || $5 || '%' OR p.rp_payment_id ILIKE '%' || $5 || '%' OR p.note ILIKE '%' || $5 || '%')`;
  return { where, params: [f.status, f.method, f.from, f.to, f.q], f };
}

const FROM = 'FROM payments p JOIN users u ON u.id = p.user_id';

router.get('/payments', wrap(async (req, res) => {
  const { where, params, f } = filterSql(req.query);
  const totals = await db.one(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE p.status = 'paid')::int AS paid_n,
            COALESCE(sum(p.base_amount) FILTER (WHERE p.status = 'paid'), 0) AS base,
            COALESCE(sum(p.tax_amount) FILTER (WHERE p.status = 'paid'), 0) AS tax,
            COALESCE(sum(p.amount) FILTER (WHERE p.status = 'paid'), 0) AS amount
       ${FROM} ${where}`, params
  );
  const pg = paginate(totals.n, req.query.page, 50);
  const rows = await db.many(
    `SELECT p.*, u.name, u.company_name, u.fee_paid_until ${FROM} ${where} ORDER BY p.id DESC LIMIT $6 OFFSET $7`,
    [...params, pg.per, pg.offset]
  );
  res.adminPage('admin/payments', { title: 'Payments', rows, totals, pg, f, STATUSES, METHODS, rpOn: razorpay.configured() });
}));

router.get('/payments.csv', wrap(async (req, res) => {
  const { where, params } = filterSql(req.query);
  const rows = await db.many(`SELECT p.*, u.name, u.company_name, u.email, u.gstin ${FROM} ${where} ORDER BY p.id`, params);
  const out = [['Payment id', 'Created (IST)', 'Paid (IST)', 'Bidder no', 'Bidder', 'Company', 'GSTIN', 'Email', 'Purpose',
    'Base (INR)', 'GST (INR)', 'Total (INR)', 'Method', 'Status', 'Razorpay order', 'Razorpay payment', 'Note']];
  for (const p of rows) {
    out.push([p.id, fmtDT(p.created_at), fmtDT(p.paid_at), bidderNo(p.user_id), p.name, p.company_name, p.gstin, p.email,
      p.purpose === 'registration_fee' ? 'Registration fee' : p.purpose, p.base_amount, p.tax_amount, p.amount,
      p.method === 'offline' ? 'Offline' : 'Razorpay', p.status, p.rp_order_id || '', p.rp_payment_id || '', p.note]);
  }
  audit(req, 'payment.export', `${rows.length} rows`);
  sendCsv(res, `payments-${new Date().toISOString().slice(0, 10)}.csv`, out);
}));

router.post('/payments/:id(\\d+)/mark-refunded', wrap(async (req, res) => {
  const p = await db.one('SELECT p.*, u.name FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = $1', [req.params.id]);
  if (!p) return notFound(res, 'This payment');
  const to = back(req, '/admin/payments');
  const note = clean(req.body.note, 500);
  if (p.status !== 'paid') { req.flash('error', 'Only a paid payment can be marked as refunded.'); return res.redirect(to); }
  if (!note) { req.flash('error', 'Enter a refund note, for example the Razorpay refund id or bank reference.'); return res.redirect(to); }
  const newNote = [p.note, `Refunded: ${note}`].filter(Boolean).join(' | ').slice(0, 2000);
  await db.query(`UPDATE payments SET status = 'refunded', note = $2 WHERE id = $1`, [p.id, newNote]);
  const revoke = req.body.revoke === '1';
  if (revoke) await payments.revokeFee(p.user_id);
  audit(req, 'payment.refund', `payment #${p.id} ${p.amount} for ${bidderNo(p.user_id)} ${p.name}: ${note}${revoke ? ' (fee revoked)' : ''}`);
  req.flash('ok', `Payment #${p.id} marked as refunded.${revoke ? ' The bidder\'s fee validity was removed.' : ''} Make the actual refund in Razorpay or by bank transfer if not done already.`);
  res.redirect(to);
}));

router.get('/payments/:id(\\d+)/refund', wrap(async (req, res) => {
  const p = await db.one('SELECT p.*, u.name, u.company_name, u.fee_paid_until FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = $1', [req.params.id]);
  if (!p) return notFound(res, 'This payment');
  res.adminPage('admin/payment_refund', { title: `Refund payment #${p.id}`, p, feeText: payments.validUntilText(p.fee_paid_until) });
}));

module.exports = router;
