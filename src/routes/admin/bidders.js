// Bidders: search, KYC review, account controls, fee, profile edits, one-off email.
const express = require('express');
const db = require('../../db');
const mailer = require('../../lib/mailer');
const payments = require('../../lib/payments');
const bidding = require('../../lib/bidding');
const settings = require('../../lib/settings');
const { clean, isEmail, token, nl2p, bidderNo, fmtDT, toInt } = require('../../lib/util');
const { wrap, audit, sendFile } = require('../../middleware');
const { paginate, notFound, sendCsv, label, back } = require('./helpers');

const router = express.Router();
const PER = 25;
const KYC = ['pending', 'incomplete', 'approved', 'rejected'];

// Path of the bidder email verification link. Matches routes/auth.js.
const VERIFY_PATH = '/verify/';

function filterSql(query) {
  const q = clean(query.q, 100);
  const kyc = KYC.includes(query.kyc) ? query.kyc : '';
  const fee = ['paid', 'unpaid'].includes(query.fee) ? query.fee : '';
  const blocked = ['yes', 'no'].includes(query.blocked) ? query.blocked : '';
  const group = query.group === 'none' ? 'none' : String(toInt(query.group, 0) || '');
  const where = `WHERE ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.company_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%'
                         OR u.phone ILIKE '%' || $1 || '%' OR u.gstin ILIKE '%' || $1 || '%' OR ('KA-' || lpad(u.id::text, 5, '0')) ILIKE '%' || $1 || '%')
                   AND ($2 = '' OR u.kyc_status = $2)
                   AND ($3 = '' OR ($3 = 'paid') = (u.fee_paid_until IS NOT NULL AND u.fee_paid_until > now()))
                   AND ($4 = '' OR u.blocked = ($4 = 'yes'))
                   AND ($5 = '' OR ($5 = 'none' AND u.group_id IS NULL) OR u.group_id::text = $5)`;
  return { where, params: [q, kyc, fee, blocked, group], f: { q, kyc, fee, blocked, group } };
}

router.get('/bidders', wrap(async (req, res) => {
  const { where, params, f } = filterSql(req.query);
  const { n } = await db.one(`SELECT count(*)::int AS n FROM users u ${where}`, params);
  const pg = paginate(n, req.query.page, PER);
  const rows = await db.many(
    `SELECT u.id, u.name, u.company_name, u.email, u.phone, u.city, u.state, u.email_verified, u.kyc_status, u.kyc_submitted_at,
            u.fee_paid_until, u.blocked, u.created_at, u.last_login_at, u.group_id, g.name AS group_name
       FROM users u LEFT JOIN bidder_groups g ON g.id = u.group_id ${where}
      ORDER BY ${f.kyc === 'pending' ? 'u.kyc_submitted_at ASC NULLS LAST,' : ''} u.id DESC
      LIMIT $6 OFFSET $7`, [...params, PER, pg.offset]
  );
  res.adminPage('admin/bidders', {
    title: 'Bidders', rows, pg, f, KYC, feeOn: settings.bool('fee_enabled'), groups: await groupList(), scripts: ['/js/admin.js'],
  });
}));

const groupList = () => db.many('SELECT id, name FROM bidder_groups ORDER BY lower(name)');

// Bulk: move the ticked bidders into a group (or out of every group).
router.post('/bidders/move-group', wrap(async (req, res) => {
  const to = back(req, '/admin/bidders');
  const raw = req.body.user_ids === undefined ? [] : [].concat(req.body.user_ids);
  const list = [...new Set(raw.map((x) => toInt(x, 0)).filter((n) => n > 0))];
  const target = String(req.body.group_id || '');
  if (!list.length) { req.flash('error', 'Tick at least one bidder in the list, then choose the group.'); return res.redirect(to); }
  if (!target) { req.flash('error', 'Choose the group to move the selected bidders to.'); return res.redirect(to); }
  const groupId = target === 'none' ? null : toInt(target, 0);
  const g = groupId ? await db.one('SELECT id, name FROM bidder_groups WHERE id = $1', [groupId]) : null;
  if (groupId && !g) { req.flash('error', 'That group no longer exists. Choose another.'); return res.redirect(to); }
  const moved = await db.many('UPDATE users SET group_id = $1 WHERE id = ANY($2::int[]) AND group_id IS DISTINCT FROM $1 RETURNING id', [groupId, list]);
  audit(req, 'bidder.move_group', `${moved.length} bidder(s) to ${g ? `#${g.id} ${g.name}` : 'no group'}: ${moved.map((m) => bidderNo(m.id)).join(', ')}`);
  req.flash('ok', moved.length
    ? `${moved.length} bidder${moved.length === 1 ? '' : 's'} moved to ${g ? g.name : 'no group'}.${list.length > moved.length ? ` ${list.length - moved.length} ${list.length - moved.length === 1 ? 'was' : 'were'} already there.` : ''}`
    : `The selected bidders are already in ${g ? g.name : 'no group'}.`);
  res.redirect(to);
}));

router.get('/bidders.csv', wrap(async (req, res) => {
  const { where, params } = filterSql(req.query);
  const rows = await db.many(
    `SELECT u.*, g.name AS group_name, ic.code AS invite_code
       FROM users u LEFT JOIN bidder_groups g ON g.id = u.group_id LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
     ${where} ORDER BY u.id`, params);
  const out = [['Bidder no', 'Name', 'Company', 'Business type', 'Email', 'Phone', 'GSTIN', 'PAN', 'Address', 'City', 'State', 'PIN code',
    'Email verified', 'Documents', 'Fee valid until', 'Blocked', 'Group', 'Sign-up code', 'Registered (IST)', 'Last sign in (IST)']];
  for (const u of rows) {
    out.push([bidderNo(u.id), u.name, u.company_name, u.business_type, u.email, u.phone, u.gstin, u.pan, u.address, u.city, u.state, u.pincode,
      u.email_verified ? 'Yes' : 'No', label('kyc', u.kyc_status), payments.validUntilText(u.fee_paid_until), u.blocked ? 'Yes' : 'No',
      u.group_name || '', u.invite_code || '', fmtDT(u.created_at), fmtDT(u.last_login_at)]);
  }
  audit(req, 'bidder.export', `${rows.length} rows`);
  sendCsv(res, `bidders-${new Date().toISOString().slice(0, 10)}.csv`, out);
}));

const loadUser = (id) => db.one('SELECT * FROM users WHERE id = $1', [id]);

router.get('/bidders/:id(\\d+)', wrap(async (req, res) => {
  const u = await loadUser(req.params.id);
  if (!u) return notFound(res, 'This bidder');
  const [docs, bids, pays, stats] = await Promise.all([
    db.many('SELECT d.id, d.doc_type, d.created_at, f.filename, f.mime, f.size FROM user_documents d JOIN files f ON f.id = d.file_id WHERE d.user_id = $1 ORDER BY d.created_at DESC', [u.id]),
    db.many(
      `SELECT b.*, l.id AS lot_id, l.lot_no, l.title AS lot_title, l.status AS lot_status, l.result, l.winning_bid_id,
              a.id AS auction_id, a.title AS auction_title
         FROM bids b JOIN lots l ON l.id = b.lot_id JOIN auctions a ON a.id = l.auction_id
        WHERE b.user_id = $1 ORDER BY b.id DESC LIMIT 50`, [u.id]),
    db.many('SELECT * FROM payments WHERE user_id = $1 ORDER BY id DESC', [u.id]),
    db.one(
      `SELECT (SELECT count(*)::int FROM bids WHERE user_id = $1 AND NOT cancelled) AS bids,
              (SELECT count(DISTINCT l.auction_id)::int FROM bids b JOIN lots l ON l.id = b.lot_id WHERE b.user_id = $1) AS auctions,
              (SELECT count(*)::int FROM lots l JOIN bids b ON b.id = l.winning_bid_id WHERE b.user_id = $1 AND l.result = 'awarded') AS won`, [u.id]),
  ]);
  const [quote, commission, group, code, groups] = await Promise.all([
    payments.feeQuoteFor(u.id), bidding.commissionFor(db, u.id),
    u.group_id ? db.one('SELECT * FROM bidder_groups WHERE id = $1', [u.group_id]) : null,
    u.invite_code_id ? db.one('SELECT id, code, label FROM invite_codes WHERE id = $1', [u.invite_code_id]) : null,
    groupList(),
  ]);
  res.adminPage('admin/bidder', {
    title: u.name, u, docs, bids, pays, stats, el: bidding.eligibility(u), feeActive: payments.feeActive(u),
    feeText: payments.validUntilText(u.fee_paid_until), quote, commission, group, code, groups,
  });
}));

router.get('/documents/:id(\\d+)', wrap(async (req, res) => {
  const d = await db.one('SELECT file_id FROM user_documents WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).end();
  await sendFile(res, d.file_id, { inline: req.query.download !== '1' });
}));

/** Run a bidder action: loads the bidder, runs fn, flashes, audits, redirects to the profile. */
const action = (name, fn) => wrap(async (req, res) => {
  const u = await loadUser(req.params.id);
  if (!u) return notFound(res, 'This bidder');
  const out = await fn(req, u);
  if (out.error) req.flash('error', out.error);
  else {
    audit(req, name, `${bidderNo(u.id)} ${u.name}${out.detail ? ': ' + out.detail : ''}`);
    req.flash('ok', out.ok);
  }
  res.redirect(out.to || `/admin/bidders/${u.id}`);
});

router.post('/bidders/:id(\\d+)/kyc/approve', action('bidder.kyc_approve', async (req, u) => {
  await db.query(`UPDATE users SET kyc_status = 'approved', kyc_note = '' WHERE id = $1`, [u.id]);
  await mailer.send('kyc_approved', u.email, { name: u.name, account_url: mailer.url('/account') });
  return { ok: `${u.name} is approved. They have been emailed.` };
}));

router.post('/bidders/:id(\\d+)/kyc/reject', action('bidder.kyc_reject', async (req, u) => {
  const reason = clean(req.body.reason, 1000);
  if (!reason) return { error: 'Write the reason for rejecting, for example "GST certificate is not readable". The bidder sees it.' };
  await db.query(`UPDATE users SET kyc_status = 'rejected', kyc_note = $2 WHERE id = $1`, [u.id, reason]);
  await mailer.send('kyc_rejected', u.email, { name: u.name, reason, account_url: mailer.url('/account/verification') });
  return { ok: `Documents rejected. ${u.name} has been emailed the reason.`, detail: reason };
}));

router.post('/bidders/:id(\\d+)/kyc/reset', action('bidder.kyc_reset', async (req, u) => {
  await db.query(`UPDATE users SET kyc_status = 'incomplete', kyc_note = '' WHERE id = $1`, [u.id]);
  return { ok: 'Verification reset. The bidder must submit documents again before bidding.' };
}));

router.post('/bidders/:id(\\d+)/block', action('bidder.block', async (req, u) => {
  await db.query('UPDATE users SET blocked = true WHERE id = $1', [u.id]);
  return { ok: `${u.name} is blocked. They are signed out and cannot sign in or bid.` };
}));

router.post('/bidders/:id(\\d+)/unblock', action('bidder.unblock', async (req, u) => {
  await db.query('UPDATE users SET blocked = false WHERE id = $1', [u.id]);
  return { ok: `${u.name} is unblocked and can sign in again.` };
}));

router.post('/bidders/:id(\\d+)/verify-email', action('bidder.verify_email', async (req, u) => {
  await db.query('UPDATE users SET email_verified = true, verify_token = NULL WHERE id = $1', [u.id]);
  return { ok: 'Email marked as verified.' };
}));

router.post('/bidders/:id(\\d+)/resend-verification', action('bidder.resend_verification', async (req, u) => {
  if (u.email_verified) return { error: 'This email address is already verified.' };
  const t = token();
  await db.query('UPDATE users SET verify_token = $2 WHERE id = $1', [u.id, t]);
  await mailer.send('verify_email', u.email, { name: u.name, verify_url: mailer.url(VERIFY_PATH + t) });
  return { ok: `A new verification link was sent to ${u.email}.` };
}));

router.post('/bidders/:id(\\d+)/fee/offline', action('bidder.fee_offline', async (req, u) => {
  const note = clean(req.body.note, 500);
  if (!note) return { error: 'Enter how the fee was paid, for example "NEFT UTR 412345678901, 20 Nov".' };
  if ((await payments.feeQuoteFor(u.id)).total <= 0) return { error: 'The registration fee for this bidder is 0, so there is nothing to record. Check the fee in Settings or in the bidder\'s group.' };
  const p = await payments.recordOffline(u.id, note);
  const fresh = await loadUser(u.id);
  return { ok: `Offline payment recorded. Fee valid until ${payments.validUntilText(fresh.fee_paid_until)}. A receipt was emailed.`, detail: `payment #${p.id} ${note}` };
}));

router.post('/bidders/:id(\\d+)/fee/revoke', action('bidder.fee_revoke', async (req, u) => {
  await payments.revokeFee(u.id);
  return { ok: 'Fee validity removed. The bidder must pay again before bidding.' };
}));

router.post('/bidders/:id(\\d+)/group', action('bidder.group', async (req, u) => {
  const groupId = toInt(req.body.group_id, 0) || null;
  const g = groupId ? await db.one('SELECT id, name FROM bidder_groups WHERE id = $1', [groupId]) : null;
  if (groupId && !g) return { error: 'That group no longer exists. Choose another.' };
  if ((u.group_id || null) === groupId) return { error: `${u.name} is already in ${g ? g.name : 'no group'}.` };
  await db.query('UPDATE users SET group_id = $2 WHERE id = $1', [u.id, groupId]);
  return { ok: `${u.name} moved to ${g ? g.name : 'no group'}. Their fee and commission now follow ${g ? 'the group' : 'the defaults'}.`, detail: g ? `group #${g.id} ${g.name}` : 'no group' };
}));

router.post('/bidders/:id(\\d+)/email', action('bidder.email', async (req, u) => {
  const subject = clean(req.body.subject, 200);
  const message = clean(req.body.message, 10000);
  if (!subject || !message) return { error: 'Enter both a subject and a message.' };
  await mailer.sendRaw(u.email, subject, nl2p(message), 'admin_message');
  return { ok: `Email queued to ${u.email}.`, detail: subject };
}));

// ---------- Edit profile ----------
const EDIT = ['name', 'email', 'phone', 'company_name', 'business_type', 'gstin', 'pan', 'address', 'city', 'state', 'pincode'];

router.get('/bidders/:id(\\d+)/edit', wrap(async (req, res) => {
  const u = await loadUser(req.params.id);
  if (!u) return notFound(res, 'This bidder');
  res.adminPage('admin/bidder_edit', { title: `Edit ${u.name}`, u, v: u, errors: {}, types: settings.list('business_types'), groups: await groupList() });
}));

router.post('/bidders/:id(\\d+)/edit', wrap(async (req, res) => {
  const u = await loadUser(req.params.id);
  if (!u) return notFound(res, 'This bidder');
  const v = {};
  for (const k of EDIT) v[k] = clean(req.body[k], k === 'address' ? 1000 : 200);
  v.email = v.email.toLowerCase();
  v.gstin = v.gstin.toUpperCase();
  v.pan = v.pan.toUpperCase();
  v.email_opt_out = req.body.email_opt_out === '1';
  v.group_id = toInt(req.body.group_id, 0) || null;
  const e = {};
  if (v.group_id && !(await db.one('SELECT 1 FROM bidder_groups WHERE id = $1', [v.group_id]))) e.group_id = 'Choose a group from the list.';
  if (!v.name) e.name = 'Enter the contact person name.';
  if (!isEmail(v.email)) e.email = 'Enter a valid email address.';
  else if (v.email !== u.email.toLowerCase() && await db.one('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [v.email, u.id])) {
    e.email = 'Another bidder already uses this email address.';
  }
  if (v.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(v.gstin)) e.gstin = 'A GSTIN has 15 characters, for example 27AAACR1234A1Z5.';
  if (v.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.pan)) e.pan = 'A PAN has 10 characters, for example AAACR1234A.';
  if (v.pincode && !/^\d{6}$/.test(v.pincode)) e.pincode = 'A PIN code has 6 digits.';
  if (Object.keys(e).length) return res.adminPage('admin/bidder_edit', { title: `Edit ${u.name}`, u, v, errors: e, types: settings.list('business_types'), groups: await groupList() });
  const emailChanged = v.email !== u.email.toLowerCase();
  await db.query(
    `UPDATE users SET ${EDIT.map((k, i) => `${k} = $${i + 2}`).join(', ')}, email_opt_out = $${EDIT.length + 2}, group_id = $${EDIT.length + 3}
            ${emailChanged ? ', email_verified = false' : ''} WHERE id = $1`,
    [u.id, ...EDIT.map((k) => v[k]), v.email_opt_out, v.group_id]
  );
  const changed = EDIT.filter((k) => String(u[k]) !== String(v[k])).concat(u.email_opt_out !== v.email_opt_out ? ['email_opt_out'] : [])
    .concat((u.group_id || null) !== v.group_id ? [`group ${u.group_id || 'none'} to ${v.group_id || 'none'}`] : []);
  audit(req, 'bidder.update', `${bidderNo(u.id)} ${v.name}: ${changed.join(', ') || 'no changes'}`);
  req.flash('ok', `Bidder details saved.${emailChanged ? ' The new email address must be verified again: use "Send verification link" or mark it verified.' : ''}`);
  res.redirect(`/admin/bidders/${u.id}`);
}));

module.exports = router;
