// Sign-up codes: generate batches, email a code to a business, deactivate, and see who used each one.
const crypto = require('crypto');
const express = require('express');
const db = require('../../db');
const settings = require('../../lib/settings');
const mailer = require('../../lib/mailer');
const { clean, toInt, isEmail, bidderNo, fmtDate, fmtDT } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { paginate, notFound, sendCsv, back } = require('./helpers');

const router = express.Router();
const PER = 50;
const MAX_BATCH = 200;
const MAX_USES = 100000;
// Uppercase letters and digits without the look-alikes 0/O and 1/I. 32 symbols, so one random
// byte masked to 5 bits picks a symbol without bias.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STATUSES = { active: 'Active', used: 'Used up', expired: 'Expired', inactive: 'Deactivated' };

const STATE_SQL = `CASE WHEN NOT c.active THEN 'inactive' WHEN c.used_count >= c.max_uses THEN 'used'
  WHEN c.expires_at IS NOT NULL AND c.expires_at <= now() THEN 'expired' ELSE 'active' END`;

/** One random code: PREFIX-XXXX-XXXX (or XXXX-XXXX without a prefix). */
function randomCode(prefix) {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] & 31];
  return `${prefix ? prefix + '-' : ''}${s.slice(0, 4)}-${s.slice(4)}`;
}

/** "2026-12-31" (IST) -> the end of that day in IST, or null. */
function endOfDayIST(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T23:59:59+05:30`);
  return isNaN(d) ? null : d;
}

const codeUrl = (code) => mailer.url('/register?code=' + encodeURIComponent(code));

function settingNotice() {
  return { required: settings.bool('require_invite_code'), open: settings.bool('registration_open') };
}

// ---------- List ----------
function filters(query) {
  const status = STATUSES[query.status] ? query.status : '';
  const group = query.group === 'none' ? 'none' : String(toInt(query.group, 0) || '');
  const q = clean(query.q, 100);
  const where = `WHERE ($1 = '' OR (${STATE_SQL}) = $1)
                   AND ($2 = '' OR ($2 = 'none' AND c.group_id IS NULL) OR c.group_id::text = $2)
                   AND ($3 = '' OR c.code ILIKE '%' || $3 || '%' OR c.label ILIKE '%' || $3 || '%')`;
  return { where, params: [status, group, q], f: { status, group, q } };
}

router.get('/codes', wrap(async (req, res) => {
  const { where, params, f } = filters(req.query);
  const { n } = await db.one(`SELECT count(*)::int AS n FROM invite_codes c ${where}`, params);
  const pg = paginate(n, req.query.page, PER);
  const rows = await db.many(
    `SELECT c.*, ${STATE_SQL} AS state, g.name AS group_name
       FROM invite_codes c LEFT JOIN bidder_groups g ON g.id = c.group_id ${where}
      ORDER BY c.id DESC LIMIT $4 OFFSET $5`, [...params, PER, pg.offset]
  );
  const counts = Object.fromEntries((await db.many(`SELECT ${STATE_SQL} AS state, count(*)::int AS n FROM invite_codes c GROUP BY 1`)).map((r) => [r.state, r.n]));
  const groups = await db.many('SELECT id, name FROM bidder_groups ORDER BY lower(name)');
  res.adminPage('admin/codes', {
    title: 'Sign-up codes', rows, pg, f, STATUSES, counts, groups, notice: settingNotice(), scripts: ['/js/admin.js'],
  });
}));

// ---------- Generate ----------
const newForm = async (res, v, errors) => res.adminPage('admin/code_new', {
  title: 'Generate sign-up codes', v, errors, MAX_BATCH, notice: settingNotice(),
  groups: await db.many('SELECT id, name FROM bidder_groups ORDER BY lower(name)'),
});

router.get('/codes/new', wrap(async (req, res) => {
  await newForm(res, { count: 1, prefix: 'KA', max_uses: 1, group_id: toInt(req.query.group, 0) || null, expires_on: '', label: '' }, {});
}));

router.post('/codes', wrap(async (req, res) => {
  const e = {};
  const v = {
    count: toInt(req.body.count, 0),
    prefix: clean(req.body.prefix, 20).toUpperCase(),
    max_uses: toInt(req.body.max_uses, 0),
    group_id: toInt(req.body.group_id, 0) || null,
    expires_on: clean(req.body.expires_on, 10),
    label: clean(req.body.label, 200),
  };
  if (v.count < 1 || v.count > MAX_BATCH) e.count = `Enter how many codes to make, from 1 to ${MAX_BATCH}.`;
  if (v.prefix && !/^[A-Z0-9]{1,8}$/.test(v.prefix)) e.prefix = 'Use up to 8 letters A to Z and digits only, for example KA or PUNE26. Leave it empty for no prefix.';
  if (String(req.body.max_uses ?? '').trim() === '') v.max_uses = 1;
  if (v.max_uses < 1 || v.max_uses > MAX_USES) e.max_uses = 'Enter how many businesses may register with each code, 1 or more.';
  if (v.group_id && !(await db.one('SELECT 1 FROM bidder_groups WHERE id = $1', [v.group_id]))) e.group_id = 'Choose a group from the list.';
  let expires = null;
  if (v.expires_on) {
    expires = endOfDayIST(v.expires_on);
    if (!expires) e.expires_on = 'Enter a valid date, or leave it empty for no expiry.';
    else if (expires <= new Date()) e.expires_on = 'The expiry date has already passed. Choose today or a later date.';
  }
  if (Object.keys(e).length) return newForm(res, v, e);

  const batch = await db.tx(async (c) => {
    const made = [];
    let guard = 0;
    while (made.length < v.count && guard++ < v.count * 20) {
      const r = (await c.query(
        `INSERT INTO invite_codes(code, label, group_id, max_uses, expires_at) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO NOTHING RETURNING id, (extract(epoch FROM created_at) * 1000000)::bigint::text AS batch`,
        [randomCode(v.prefix), v.label, v.group_id, v.max_uses, expires]
      )).rows[0];
      if (r) made.push(r);
    }
    if (made.length < v.count) throw new Error('Could not generate enough unique codes');
    return made[0].batch; // created_at is the transaction time, shared by the whole batch
  });
  audit(req, 'code.generate', `${v.count} code(s)${v.prefix ? ' prefix ' + v.prefix : ''}, ${v.max_uses} use(s) each${v.group_id ? ', group #' + v.group_id : ''}${expires ? ', expire ' + v.expires_on : ''}${v.label ? ', ' + v.label : ''}`);
  req.flash('ok', `${v.count} sign-up code${v.count === 1 ? '' : 's'} created.`);
  res.redirect(`/admin/codes/batch/${batch}`);
}));

const batchRows = (batch) => db.many(
  `SELECT c.*, ${STATE_SQL} AS state, g.name AS group_name
     FROM invite_codes c LEFT JOIN bidder_groups g ON g.id = c.group_id
    WHERE (extract(epoch FROM c.created_at) * 1000000)::bigint = $1::bigint ORDER BY c.id`, [batch]
);

router.get('/codes/batch/:batch(\\d+)', wrap(async (req, res) => {
  const rows = await batchRows(req.params.batch);
  if (!rows.length) return notFound(res, 'This batch of codes');
  res.adminPage('admin/code_batch', { title: 'New sign-up codes', rows, batch: req.params.batch, codeUrl, scripts: ['/js/admin.js'] });
}));

router.get('/codes/batch/:batch(\\d+).csv', wrap(async (req, res) => {
  const rows = await batchRows(req.params.batch);
  if (!rows.length) return res.status(404).end();
  const out = [['Code', 'Registration link', 'Issued to', 'Group', 'Uses allowed', 'Expires (IST)', 'Created (IST)']];
  for (const c of rows) out.push([c.code, codeUrl(c.code), c.label, c.group_name || '', c.max_uses, c.expires_at ? fmtDate(c.expires_at) : 'No expiry', fmtDT(c.created_at)]);
  audit(req, 'code.export_batch', `${rows.length} code(s)`);
  sendCsv(res, `sign-up-codes-${fmtDate(rows[0].created_at).replace(/\s+/g, '-')}.csv`, out);
}));

// ---------- Detail ----------
const loadCode = (id) => db.one(
  `SELECT c.*, ${STATE_SQL} AS state, g.name AS group_name,
          (SELECT count(*)::int FROM users u WHERE u.invite_code_id = c.id) AS user_count
     FROM invite_codes c LEFT JOIN bidder_groups g ON g.id = c.group_id WHERE c.id = $1`, [id]
);

router.get('/codes/:id(\\d+)', wrap(async (req, res) => {
  const c = await loadCode(req.params.id);
  if (!c) return notFound(res, 'This sign-up code');
  const users = await db.many(
    `SELECT u.id, u.name, u.company_name, u.email, u.kyc_status, u.created_at, g.name AS group_name
       FROM users u LEFT JOIN bidder_groups g ON g.id = u.group_id WHERE u.invite_code_id = $1 ORDER BY u.id`, [c.id]);
  const sent = await db.many(
    `SELECT to_email, created_at, status FROM email_log WHERE template_key = 'invite_code' AND html LIKE '%' || $1 || '%' ORDER BY id DESC LIMIT 20`, [c.code]);
  res.adminPage('admin/code', {
    title: `Code ${c.code}`, c, users, sent, url: codeUrl(c.code), notice: settingNotice(), errors: {}, m: {}, scripts: ['/js/admin.js'],
  });
}));

/** Load the code, run fn, flash, redirect to the detail page (or the back URL). */
const action = (name, fn) => wrap(async (req, res) => {
  const c = await loadCode(req.params.id);
  if (!c) return notFound(res, 'This sign-up code');
  const out = await fn(req, c);
  if (out.error) req.flash('error', out.error);
  else {
    audit(req, name, `${c.code}${out.detail ? ': ' + out.detail : ''}`);
    req.flash('ok', out.ok);
  }
  res.redirect(out.to || back(req, `/admin/codes/${c.id}`));
});

router.post('/codes/:id(\\d+)/deactivate', action('code.deactivate', async (req, c) => {
  if (!c.active) return { error: 'This code is already deactivated.' };
  await db.query('UPDATE invite_codes SET active = false WHERE id = $1', [c.id]);
  return { ok: `${c.code} is deactivated. Nobody can register with it until you reactivate it.` };
}));

router.post('/codes/:id(\\d+)/reactivate', action('code.reactivate', async (req, c) => {
  if (c.active) return { error: 'This code is already active.' };
  await db.query('UPDATE invite_codes SET active = true WHERE id = $1', [c.id]);
  const why = c.used_count >= c.max_uses ? ' It has no uses left, so it still cannot be used.' : c.expires_at && new Date(c.expires_at) <= new Date() ? ' It has expired, so it still cannot be used.' : '';
  return { ok: `${c.code} is active again.${why}` };
}));

router.post('/codes/:id(\\d+)/delete', action('code.delete', async (req, c) => {
  if (c.used_count > 0 || c.user_count > 0) return { error: `${c.code} has been used to register, so it is kept as a record. Deactivate it instead.` };
  const r = await db.query('DELETE FROM invite_codes WHERE id = $1 AND used_count = 0 AND NOT EXISTS (SELECT 1 FROM users WHERE invite_code_id = $1)', [c.id]);
  if (!r.rowCount) return { error: `${c.code} has just been used, so it cannot be deleted. Deactivate it instead.` };
  return { ok: `Code ${c.code} deleted.`, to: back(req, '/admin/codes') };
}));

router.post('/codes/:id(\\d+)/email', wrap(async (req, res) => {
  const c = await loadCode(req.params.id);
  if (!c) return notFound(res, 'This sign-up code');
  const m = { name: clean(req.body.name, 200), company: clean(req.body.company, 200), email: clean(req.body.email, 200).toLowerCase() };
  const errors = {};
  if (!m.name) errors.name = 'Enter the name of the person you are inviting.';
  if (!isEmail(m.email)) errors.email = 'Enter a valid email address, for example purchase@company.in.';
  if (c.state !== 'active') errors.form = `This code cannot be used right now (${STATUSES[c.state].toLowerCase()}). ${c.state === 'inactive' ? 'Reactivate it' : 'Generate a new code'} before emailing it.`;
  if (Object.keys(errors).length) {
    const users = await db.many('SELECT u.id, u.name, u.company_name, u.email, u.kyc_status, u.created_at, NULL AS group_name FROM users u WHERE u.invite_code_id = $1', [c.id]);
    return res.adminPage('admin/code', { title: `Code ${c.code}`, c, users, sent: [], url: codeUrl(c.code), notice: settingNotice(), errors, m, scripts: ['/js/admin.js'] });
  }
  const id = await mailer.send('invite_code', m.email, {
    name: m.name, company: m.company, code: c.code, register_url: codeUrl(c.code),
    expires_on: c.expires_at ? fmtDate(c.expires_at) : 'No expiry', group_name: c.group_name || '',
  });
  if (!id) {
    req.flash('error', 'The email could not be queued. Check that the "Sign-up code invitation" email template is turned on under Email templates.');
    return res.redirect(`/admin/codes/${c.id}`);
  }
  if (!c.label) await db.query('UPDATE invite_codes SET label = $2 WHERE id = $1', [c.id, [m.company, m.name].filter(Boolean).join(', ').slice(0, 200)]);
  audit(req, 'code.email', `${c.code} to ${m.email}`);
  req.flash('ok', `Invitation with code ${c.code} queued to ${m.email}.`);
  res.redirect(`/admin/codes/${c.id}`);
}));

module.exports = router;
module.exports.randomCode = randomCode;
