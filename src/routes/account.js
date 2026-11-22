const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const settings = require('../lib/settings');
const mailer = require('../lib/mailer');
const razorpay = require('../lib/razorpay');
const payments = require('../lib/payments');
const { clean, bidderNo } = require('../lib/util');
const mw = require('../middleware');

const { wrap, requireUser } = mw;
const router = express.Router();

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PIN_RE = /^[1-9][0-9]{5}$/;
const phoneOk = (s) => /^\+?[0-9]{10,13}$/.test(String(s || '').replace(/[\s\-()]/g, ''));
const DAY = 24 * 3600 * 1000;

router.use('/account', requireUser);

/** Fields the verification page needs before documents can be submitted. */
function missingProfile(u) {
  const miss = [];
  if (!u.company_name) miss.push('company name');
  if (!u.gstin && !u.pan) miss.push('GSTIN or PAN');
  if (!u.address) miss.push('address');
  if (!u.city) miss.push('city');
  if (!u.state) miss.push('state');
  if (!u.pincode) miss.push('pincode');
  return miss;
}

/** Fee state shared by the overview and fee pages. */
function feeInfo(user) {
  const enabled = settings.bool('fee_enabled');
  const active = payments.feeActive(user);
  const until = payments.validUntilText(user.fee_paid_until);
  const expiresSoon = active && until !== 'No expiry' && new Date(user.fee_paid_until) - Date.now() < 30 * DAY;
  return { enabled, active, until, expiresSoon, quote: payments.feeQuote() };
}

/* ---------------- Overview ---------------- */

router.get('/account', wrap(async (req, res) => {
  const u = req.user;
  const rows = await db.many(
    `SELECT l.id, l.lot_no, l.title, l.ends_at, l.unit, a.id AS auction_id, a.title AS auction_title, a.show_highest_bid,
            (SELECT max(amount) FROM bids b WHERE b.lot_id = l.id AND b.user_id = $1 AND NOT b.cancelled) AS my_amount,
            t.amount AS top_amount, (t.user_id = $1) AS leading
       FROM lots l
       JOIN auctions a ON a.id = l.auction_id
       LEFT JOIN LATERAL (SELECT amount, user_id FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled
                           ORDER BY amount DESC, id ASC LIMIT 1) t ON true
      WHERE a.status = 'published' AND l.status = 'open' AND now() >= a.starts_at
        AND EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = l.id AND b.user_id = $1 AND NOT b.cancelled)
      ORDER BY l.ends_at, l.lot_no LIMIT 25`, [u.id]
  );
  // Never pass another bidder's identity to the view; hide the top amount where the auction hides it.
  const activeLots = rows.map((r) => ({ ...r, top_amount: r.show_highest_bid || r.leading ? r.top_amount : null }));
  res.page('account/overview', {
    title: 'My account', tab: 'overview', bidderNo: bidderNo(u.id), fee: feeInfo(u), activeLots,
    kycRequired: settings.bool('require_kyc_approval'), serverNow: Date.now(),
  });
}));

router.post('/account/email-preferences', wrap(async (req, res) => {
  const wants = req.body.announcements === '1';
  await db.query('UPDATE users SET email_opt_out = $2 WHERE id = $1', [req.user.id, !wants]);
  req.flash('ok', wants ? 'You will get emails about new auctions and reminders.' : 'You will no longer get emails about new auctions and reminders. Bid and payment emails still arrive.');
  res.redirect('/account');
}));

/* ---------------- Business profile ---------------- */

function renderProfile(req, res, values, errors, status = 200) {
  const types = settings.list('business_types');
  if (values.business_type && !types.includes(values.business_type)) types.push(values.business_type);
  res.status(status);
  res.page('account/profile', {
    title: 'Business profile', tab: 'profile', values, errors, states: STATES, businessTypes: types,
    locked: req.user.kyc_status === 'approved',
  });
}

router.get('/account/profile', (req, res) => renderProfile(req, res, req.user, {}));

router.post('/account/profile', wrap(async (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const locked = u.kyc_status === 'approved';
  const v = {
    name: clean(b.name, 100),
    phone: clean(b.phone, 20),
    company_name: locked ? u.company_name : clean(b.company_name, 150),
    business_type: clean(b.business_type, 60),
    gstin: locked ? u.gstin : clean(b.gstin, 15).toUpperCase().replace(/\s/g, ''),
    pan: locked ? u.pan : clean(b.pan, 10).toUpperCase().replace(/\s/g, ''),
    address: clean(b.address, 400),
    city: clean(b.city, 80),
    state: clean(b.state, 80),
    pincode: clean(b.pincode, 6),
  };
  const types = settings.list('business_types');
  const e = {};
  if (v.name.length < 2) e.name = 'Enter your full name.';
  if (!phoneOk(v.phone)) e.phone = 'Enter a 10 digit mobile number. You can add +91 in front.';
  if (!locked && v.company_name.length < 2) e.company_name = 'Enter the name of your company or firm.';
  if (v.business_type && !types.includes(v.business_type) && v.business_type !== u.business_type) e.business_type = 'Choose one of the listed business types.';
  if (!locked && v.gstin && !GSTIN_RE.test(v.gstin)) e.gstin = 'A GSTIN has 15 characters, for example 27AAPFU0939F1ZV. Check it against your GST certificate.';
  if (!locked && v.pan && !PAN_RE.test(v.pan)) e.pan = 'A PAN has 10 characters: 5 letters, 4 digits and 1 letter, for example AAPFU0939F.';
  if (v.state && !STATES.includes(v.state)) e.state = 'Choose a state or union territory from the list.';
  if (v.pincode && !PIN_RE.test(v.pincode)) e.pincode = 'A pincode has 6 digits.';
  if (Object.keys(e).length) return renderProfile(req, res, { ...u, ...v }, e, 422);

  await db.query(
    `UPDATE users SET name = $2, phone = $3, company_name = $4, business_type = $5, gstin = $6, pan = $7,
            address = $8, city = $9, state = $10, pincode = $11 WHERE id = $1`,
    [u.id, v.name, v.phone, v.company_name, v.business_type, v.gstin, v.pan, v.address, v.city, v.state, v.pincode]
  );
  req.flash('ok', 'Business profile saved.');
  res.redirect('/account/profile');
}));

/* ---------------- Verification documents ---------------- */

const userDocs = (userId) => db.many(
  `SELECT d.id, d.doc_type, d.created_at, f.filename, f.size, f.mime
     FROM user_documents d JOIN files f ON f.id = d.file_id WHERE d.user_id = $1 ORDER BY d.created_at`, [userId]
);

router.get('/account/verification', wrap(async (req, res) => {
  const u = req.user;
  const required = settings.list('required_documents');
  const docs = await userDocs(u.id);
  const slots = required.map((type) => ({ type, files: docs.filter((d) => d.doc_type === type) }));
  const other = docs.filter((d) => !required.includes(d.doc_type));
  const missing = missingProfile(u);
  const docsComplete = slots.every((s) => s.files.length > 0);
  const canSubmit = !missing.length && docsComplete && ['incomplete', 'rejected'].includes(u.kyc_status);
  res.page('account/verification', {
    title: 'Verification', tab: 'verification', slots, other, missing, docsComplete, canSubmit,
    kycRequired: settings.bool('require_kyc_approval'), editable: u.kyc_status !== 'approved',
  });
}));

router.post('/account/verification/upload', mw.upload.single('file'), wrap(async (req, res) => {
  const docType = clean(req.body && req.body.doc_type, 100);
  if (!settings.list('required_documents').includes(docType)) {
    req.flash('error', 'Choose which document you are uploading and try again.');
    return res.redirect('/account/verification');
  }
  if (req.user.kyc_status === 'approved') {
    req.flash('error', 'Your documents are already approved. Contact support if you need to change them.');
    return res.redirect('/account/verification');
  }
  if (!req.file) {
    req.flash('error', `No file was uploaded for ${docType}. Choose a PDF, JPG, PNG or WebP file of up to 5 MB.`);
    return res.redirect('/account/verification');
  }
  const fileId = await mw.saveFile(req.file);
  await db.query('INSERT INTO user_documents(user_id, doc_type, file_id) VALUES($1,$2,$3)', [req.user.id, docType, fileId]);
  req.flash('ok', `${docType} uploaded.`);
  res.redirect('/account/verification');
}));

router.post('/account/verification/remove/:id', wrap(async (req, res) => {
  if (req.user.kyc_status === 'approved') {
    req.flash('error', 'Your documents are already approved. Contact support if you need to change them.');
    return res.redirect('/account/verification');
  }
  // Deleting the file row removes the document row too (ON DELETE CASCADE).
  const r = await db.query(
    'DELETE FROM files WHERE id = (SELECT file_id FROM user_documents WHERE id = $1 AND user_id = $2)',
    [parseInt(req.params.id, 10) || 0, req.user.id]
  );
  req.flash(r.rowCount ? 'ok' : 'error', r.rowCount ? 'Document removed.' : 'That document was not found. It may already have been removed.');
  res.redirect('/account/verification');
}));

router.post('/account/verification/submit', wrap(async (req, res) => {
  const u = req.user;
  const required = settings.list('required_documents');
  const docs = await userDocs(u.id);
  const missing = missingProfile(u);
  const missingDocs = required.filter((t) => !docs.some((d) => d.doc_type === t));
  if (!['incomplete', 'rejected'].includes(u.kyc_status)) {
    req.flash('info', u.kyc_status === 'pending' ? 'Your documents are already with us for review.' : 'Your documents are already approved.');
    return res.redirect('/account/verification');
  }
  if (missing.length || missingDocs.length) {
    const parts = [];
    if (missing.length) parts.push('add your ' + missing.join(', ') + ' in the business profile');
    if (missingDocs.length) parts.push('upload ' + missingDocs.join(', '));
    req.flash('error', 'Before submitting, ' + parts.join(' and ') + '.');
    return res.redirect('/account/verification');
  }
  await db.query(
    `UPDATE users SET kyc_status = 'pending', kyc_submitted_at = now(), kyc_note = '' WHERE id = $1`, [u.id]
  );
  await mailer.notifyAdmin('kyc_submitted_admin', {
    bidder_name: u.name, company: u.company_name, bidder_no: bidderNo(u.id), admin_url: mailer.url('/admin/bidders/' + u.id),
  }).catch((err) => console.error('kyc admin mail', err.message));
  req.flash('ok', 'Documents submitted for review. We will email you when they have been checked, usually within one working day.');
  res.redirect('/account/verification');
}));

router.get('/account/documents/:id', wrap(async (req, res) => {
  const d = await db.one('SELECT file_id FROM user_documents WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10) || 0, req.user.id]);
  if (!d) return res.status(404).render('error', { title: 'Document not found', message: 'This document does not exist or does not belong to your account.' });
  await mw.sendFile(res, d.file_id);
}));

/* ---------------- Registration fee ---------------- */

router.get('/account/fee', (req, res) => {
  const fee = feeInfo(req.user);
  const canPay = fee.enabled && fee.quote.total > 0 && (!fee.active || fee.expiresSoon);
  const online = razorpay.configured();
  res.page('account/fee', {
    title: 'Registration fee', tab: 'fee', fee, canPay, online,
    scripts: canPay && online ? ['https://checkout.razorpay.com/v1/checkout.js', '/js/pay.js'] : [],
  });
});

router.post('/account/fee/order', wrap(async (req, res) => {
  const fee = feeInfo(req.user);
  if (!fee.enabled || fee.quote.total <= 0) return res.status(400).json({ error: 'No registration fee is required at the moment.' });
  if (fee.active && !fee.expiresSoon) return res.status(400).json({ error: `Your fee is already paid until ${fee.until}.` });
  if (!razorpay.configured()) return res.status(400).json({ error: 'Online payment is not available yet. Contact support for bank transfer details.' });
  let out;
  try {
    out = await payments.createFeeOrder(req.user);
  } catch (err) {
    console.error('fee order', err.message);
    return res.status(502).json({ error: 'We could not start the payment with the payment gateway. Try again in a minute.' });
  }
  const u = req.user;
  res.json({
    orderId: out.order.id,
    amount: out.order.amount || Math.round(out.payment.amount * 100),
    currency: out.order.currency || 'INR',
    key: process.env.RAZORPAY_KEY_ID,
    name: u.name, email: u.email, phone: u.phone,
    siteName: settings.get('site_name'),
  });
}));

router.post('/account/fee/verify', wrap(async (req, res) => {
  const b = req.body || {};
  const orderId = clean(b.razorpay_order_id, 100);
  const paymentId = clean(b.razorpay_payment_id, 100);
  const signature = clean(b.razorpay_signature, 200);
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'The payment response was incomplete. If money was deducted, contact support with the payment ID from your bank.' });
  const p = await db.one('SELECT id FROM payments WHERE rp_order_id = $1 AND user_id = $2', [orderId, req.user.id]);
  if (!p) return res.status(404).json({ error: 'This payment does not belong to your account. Reload the page and try again.' });
  if (!razorpay.verifyCheckout({ orderId, paymentId, signature })) {
    return res.status(400).json({ error: `We could not confirm this payment. If money was deducted, it will be confirmed automatically within a few minutes; otherwise contact support and quote payment ID ${paymentId}.` });
  }
  await payments.markPaidByOrder(orderId, paymentId);
  req.flash('ok', 'Payment received. Your registration fee is now active and a receipt is on its way to your email.');
  res.json({ ok: true });
}));

/* ---------------- Bids and payments ---------------- */

router.get('/account/bids', wrap(async (req, res) => {
  const uid = req.user.id;
  const rows = await db.many(
    `SELECT l.id, l.lot_no, l.title, l.status, l.result, l.ends_at, l.unit,
            a.id AS auction_id, a.title AS auction_title, a.status AS auction_status, a.starts_at,
            mb.my_amount, (t.user_id = $1) AS leading, (wb.user_id = $1) AS won
       FROM (SELECT lot_id, max(amount) AS my_amount FROM bids WHERE user_id = $1 AND NOT cancelled GROUP BY lot_id) mb
       JOIN lots l ON l.id = mb.lot_id
       JOIN auctions a ON a.id = l.auction_id
       LEFT JOIN LATERAL (SELECT user_id FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled
                           ORDER BY amount DESC, id ASC LIMIT 1) t ON true
       LEFT JOIN bids wb ON wb.id = l.winning_bid_id
      ORDER BY (l.status = 'open' AND a.status = 'published') DESC, l.ends_at DESC
      LIMIT 500`, [uid]
  );
  const lots = rows.map((r) => {
    let standing; let tone;
    if (r.auction_status !== 'published') { standing = 'Auction cancelled'; tone = ''; }
    else if (r.status === 'open') { standing = r.leading ? 'Leading' : 'Outbid'; tone = r.leading ? 'tag-ok' : 'tag-bad'; }
    else if (r.won && r.result === 'awarded') { standing = 'Awarded to you'; tone = 'tag-ok'; }
    else if (r.won && r.result === 'pending') { standing = 'Awaiting seller decision'; tone = 'tag-warn'; }
    else if (r.won && r.result === 'rejected') { standing = 'Not awarded'; tone = ''; }
    else { standing = 'Outbid'; tone = ''; }
    return { ...r, standing, tone };
  });
  res.page('account/bids', { title: 'My bids', tab: 'bids', lots });
}));

router.get('/account/payments', wrap(async (req, res) => {
  const rows = await db.many('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [req.user.id]);
  res.page('account/payments', { title: 'Payments', tab: 'payments', rows });
}));

/* ---------------- Password ---------------- */

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'pw:' + req.user.id,
  handler: (req, res) => { req.flash('error', 'Too many attempts. Wait 15 minutes and try again.'); res.redirect('/account/password'); },
});

router.get('/account/password', (req, res) => res.page('account/password', { title: 'Change password', tab: 'password', errors: {} }));

router.post('/account/password', passwordLimiter, wrap(async (req, res) => {
  const cur = String(req.body.current || '');
  const pw = String(req.body.password || '');
  const e = {};
  if (!(await bcrypt.compare(cur, req.user.password_hash))) e.current = 'This is not your current password.';
  if (pw.length < 8) e.password = 'Use at least 8 characters.';
  else if (pw.length > 200) e.password = 'Use at most 200 characters.';
  else if (String(req.body.confirm || '') !== pw) e.confirm = 'The two passwords do not match.';
  if (Object.keys(e).length) {
    res.status(422);
    return res.page('account/password', { title: 'Change password', tab: 'password', errors: e });
  }
  await db.query('UPDATE users SET password_hash = $2, reset_token = NULL, reset_expires = NULL WHERE id = $1', [req.user.id, await bcrypt.hash(pw, 11)]);
  req.flash('ok', 'Password changed. Use the new password next time you sign in.');
  res.redirect('/account/password');
}));

module.exports = router;
