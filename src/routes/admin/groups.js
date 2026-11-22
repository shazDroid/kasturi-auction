// Bidder groups: their own registration fee and buyer's commission, members, and the
// restricted auctions and sign-up codes that use them.
const express = require('express');
const db = require('../../db');
const settings = require('../../lib/settings');
const { PHASE_SQL } = require('../../lib/bidding');
const { clean, toInt, toMoney, bidderNo } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { notFound, back } = require('./helpers');

const router = express.Router();
const SEARCH_LIMIT = 50;

const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
/** Distinct positive integer ids from a form field that may repeat. */
const ids = (x) => [...new Set(arr(x).map((v) => toInt(v, 0)).filter((n) => n > 0))];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

/** Default values from Settings, for "Default (...)" labels. */
const defaults = () => ({ fee: settings.num('fee_amount'), commission: settings.num('default_commission_percent') });

const loadGroup = (id) => db.one(
  `SELECT g.*, (SELECT count(*)::int FROM users u WHERE u.group_id = g.id) AS member_count,
          (SELECT count(*)::int FROM auction_groups ag JOIN auctions a ON a.id = ag.auction_id
            WHERE ag.group_id = g.id AND a.visibility = 'restricted') AS auction_count,
          (SELECT count(*)::int FROM invite_codes c WHERE c.group_id = g.id) AS code_count,
          (SELECT count(*)::int FROM lot_group_prices p WHERE p.group_id = g.id) AS price_count
     FROM bidder_groups g WHERE g.id = $1`, [id]
);

// ---------- List ----------
router.get('/groups', wrap(async (req, res) => {
  const rows = await db.many(
    `SELECT g.*, (SELECT count(*)::int FROM users u WHERE u.group_id = g.id) AS member_count,
            (SELECT count(*)::int FROM auction_groups ag JOIN auctions a ON a.id = ag.auction_id
              WHERE ag.group_id = g.id AND a.visibility = 'restricted') AS auction_count,
            (SELECT count(*)::int FROM invite_codes c WHERE c.group_id = g.id AND c.active
              AND c.used_count < c.max_uses AND (c.expires_at IS NULL OR c.expires_at > now())) AS active_codes
       FROM bidder_groups g ORDER BY lower(g.name)`
  );
  const { ungrouped } = await db.one('SELECT count(*)::int AS ungrouped FROM users WHERE group_id IS NULL');
  res.adminPage('admin/groups', { title: 'Bidder groups', rows, ungrouped, D: defaults() });
}));

// ---------- Create / edit ----------
function readGroupForm(body) {
  const e = {};
  const feeRaw = String(body.fee_amount ?? '').trim();
  const comRaw = String(body.commission_percent ?? '').trim().replace(/%$/, '');
  const v = {
    name: clean(body.name, 100).replace(/\s+/g, ' '),
    description: clean(body.description, 500),
    fee_amount: feeRaw === '' ? null : toMoney(feeRaw),
    commission_percent: comRaw === '' ? null : (/^\d{1,3}(\.\d{1,2})?$/.test(comRaw) ? Number(comRaw) : NaN),
  };
  if (!v.name) e.name = 'Enter a name for the group, for example "Recyclers".';
  if (v.fee_amount !== null && !(v.fee_amount >= 0)) e.fee_amount = 'Enter the fee in rupees before GST, for example 3000, or leave it empty to use the default.';
  if (v.commission_percent !== null && !(v.commission_percent >= 0 && v.commission_percent <= 100)) {
    e.commission_percent = 'Enter a percentage from 0 to 100 with up to 2 decimals, for example 1.5, or leave it empty to use the default.';
  }
  return { v, e };
}

const formPage = (res, group, v, errors) => res.adminPage('admin/group_form', {
  title: group ? `Edit ${group.name}` : 'New bidder group', group, v, errors, D: defaults(),
});

router.get('/groups/new', (req, res) => formPage(res, null, { name: '', description: '', fee_amount: null, commission_percent: null }, {}));

router.post('/groups', wrap(async (req, res) => {
  const { v, e } = readGroupForm(req.body);
  if (!e.name && await db.one('SELECT 1 FROM bidder_groups WHERE lower(name) = lower($1)', [v.name])) e.name = `A group called "${v.name}" already exists. Use another name.`;
  if (Object.keys(e).length) return formPage(res, null, v, e);
  const g = await db.one(
    'INSERT INTO bidder_groups(name, description, fee_amount, commission_percent) VALUES($1,$2,$3,$4) RETURNING id',
    [v.name, v.description, v.fee_amount, v.commission_percent]
  );
  audit(req, 'group.create', `#${g.id} ${v.name}`);
  req.flash('ok', `Group "${v.name}" created. Add bidders to it below.`);
  res.redirect(`/admin/groups/${g.id}`);
}));

router.get('/groups/:id(\\d+)/edit', wrap(async (req, res) => {
  const g = await loadGroup(req.params.id);
  if (!g) return notFound(res, 'This group');
  formPage(res, g, g, {});
}));

router.post('/groups/:id(\\d+)', wrap(async (req, res) => {
  const g = await loadGroup(req.params.id);
  if (!g) return notFound(res, 'This group');
  const { v, e } = readGroupForm(req.body);
  if (!e.name && await db.one('SELECT 1 FROM bidder_groups WHERE lower(name) = lower($1) AND id <> $2', [v.name, g.id])) {
    e.name = `Another group is already called "${v.name}". Use another name.`;
  }
  if (Object.keys(e).length) return formPage(res, g, v, e);
  await db.query('UPDATE bidder_groups SET name = $2, description = $3, fee_amount = $4, commission_percent = $5 WHERE id = $1',
    [g.id, v.name, v.description, v.fee_amount, v.commission_percent]);
  const changes = [];
  if (g.name !== v.name) changes.push(`name ${g.name} to ${v.name}`);
  if (g.fee_amount !== v.fee_amount) changes.push(`fee ${g.fee_amount ?? 'default'} to ${v.fee_amount ?? 'default'}`);
  if (g.commission_percent !== v.commission_percent) changes.push(`commission ${g.commission_percent ?? 'default'} to ${v.commission_percent ?? 'default'}`);
  audit(req, 'group.update', `#${g.id} ${v.name}${changes.length ? ': ' + changes.join(', ') : ''}`);
  req.flash('ok', `Group "${v.name}" saved.${g.fee_amount !== v.fee_amount ? ' The new fee applies to the next payment of each bidder in it.' : ''}`);
  res.redirect(`/admin/groups/${g.id}`);
}));

// ---------- Detail ----------
router.get('/groups/:id(\\d+)', wrap(async (req, res) => {
  const g = await loadGroup(req.params.id);
  if (!g) return notFound(res, 'This group');
  const q = clean(req.query.q, 100);
  const [members, auctions, codes, others] = await Promise.all([
    db.many(
      `SELECT u.id, u.name, u.company_name, u.email, u.city, u.kyc_status, u.blocked, u.created_at
         FROM users u WHERE u.group_id = $1 ORDER BY lower(u.company_name), lower(u.name)`, [g.id]),
    db.many(
      `SELECT a.id, a.title, a.starts_at, a.ends_at, a.status, a.visibility, ${PHASE_SQL} AS phase
         FROM auction_groups ag JOIN auctions a ON a.id = ag.auction_id
        WHERE ag.group_id = $1 ORDER BY a.starts_at DESC`, [g.id]),
    db.many(
      `SELECT c.*, CASE WHEN NOT c.active THEN 'inactive' WHEN c.used_count >= c.max_uses THEN 'used'
                        WHEN c.expires_at IS NOT NULL AND c.expires_at <= now() THEN 'expired' ELSE 'active' END AS state
         FROM invite_codes c WHERE c.group_id = $1 ORDER BY c.id DESC LIMIT 100`, [g.id]),
    db.many('SELECT id, name FROM bidder_groups WHERE id <> $1 ORDER BY lower(name)', [g.id]),
  ]);
  let results = null;
  if (q) {
    results = await db.many(
      `SELECT u.id, u.name, u.company_name, u.email, u.city, g2.name AS group_name
         FROM users u LEFT JOIN bidder_groups g2 ON g2.id = u.group_id
        WHERE u.group_id IS DISTINCT FROM $1
          AND (u.name ILIKE '%' || $2 || '%' OR u.company_name ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%'
               OR ('KA-' || lpad(u.id::text, 5, '0')) ILIKE '%' || $2 || '%')
        ORDER BY lower(u.company_name), lower(u.name) LIMIT $3`, [g.id, q, SEARCH_LIMIT + 1]);
  }
  res.adminPage('admin/group', {
    title: g.name, g, members, auctions, codes, others, q, results, SEARCH_LIMIT, D: defaults(),
    scripts: ['/js/admin.js'],
  });
}));

// ---------- Members ----------
router.post('/groups/:id(\\d+)/members', wrap(async (req, res) => {
  const g = await loadGroup(req.params.id);
  if (!g) return notFound(res, 'This group');
  const list = ids(req.body.user_ids);
  const to = back(req, `/admin/groups/${g.id}`);
  if (!list.length) { req.flash('error', 'Tick at least one bidder to add.'); return res.redirect(to); }
  const moved = await db.many(
    `UPDATE users u SET group_id = $1 FROM users old LEFT JOIN bidder_groups og ON og.id = old.group_id
      WHERE u.id = old.id AND u.id = ANY($2::int[]) AND u.group_id IS DISTINCT FROM $1
  RETURNING u.id, og.name AS old_group`, [g.id, list]);
  const fromOther = moved.filter((m) => m.old_group).length;
  audit(req, 'group.add_members', `#${g.id} ${g.name}: ${moved.map((m) => bidderNo(m.id)).join(', ')}`);
  req.flash('ok', moved.length
    ? `${plural(moved.length, 'bidder')} added to ${g.name}.${fromOther ? ` ${fromOther} of them ${fromOther === 1 ? 'was' : 'were'} moved from another group.` : ''}`
    : 'Those bidders are already in this group.');
  res.redirect(`/admin/groups/${g.id}`);
}));

router.post('/groups/:id(\\d+)/members/:userId(\\d+)/remove', wrap(async (req, res) => {
  const u = await db.one('UPDATE users SET group_id = NULL WHERE id = $1 AND group_id = $2 RETURNING id, name', [req.params.userId, req.params.id]);
  if (!u) req.flash('info', 'That bidder is no longer in this group.');
  else {
    audit(req, 'group.remove_member', `#${req.params.id}: ${bidderNo(u.id)} ${u.name}`);
    req.flash('ok', `${u.name} was removed from the group. The default fee and commission now apply to them.`);
  }
  res.redirect(back(req, `/admin/groups/${req.params.id}`));
}));

// ---------- Delete ----------
router.post('/groups/:id(\\d+)/delete', wrap(async (req, res) => {
  const g = await loadGroup(req.params.id);
  if (!g) return notFound(res, 'This group');
  const moveTo = toInt(req.body.move_to, 0) || null;
  if (g.member_count > 0) {
    if (!moveTo && req.body.move_to !== 'none') {
      req.flash('error', `${g.name} still has ${plural(g.member_count, 'bidder')}. Choose where to move them, then delete the group.`);
      return res.redirect(`/admin/groups/${g.id}#delete`);
    }
    if (moveTo && (moveTo === g.id || !(await db.one('SELECT 1 FROM bidder_groups WHERE id = $1', [moveTo])))) {
      req.flash('error', 'Choose another group from the list to move the bidders to.');
      return res.redirect(`/admin/groups/${g.id}#delete`);
    }
  }
  const target = moveTo ? await db.one('SELECT name FROM bidder_groups WHERE id = $1', [moveTo]) : null;
  await db.tx(async (c) => {
    if (g.member_count > 0) await c.query('UPDATE users SET group_id = $2 WHERE group_id = $1', [g.id, moveTo]);
    await c.query('DELETE FROM bidder_groups WHERE id = $1', [g.id]);
  });
  audit(req, 'group.delete', `#${g.id} ${g.name}${g.member_count ? `, ${g.member_count} bidder(s) moved to ${target ? target.name : 'no group'}` : ''}`);
  const notes = [];
  if (g.member_count) notes.push(`${plural(g.member_count, 'bidder')} moved to ${target ? target.name : 'no group'}.`);
  if (g.auction_count) notes.push(`${plural(g.auction_count, 'restricted auction')} no longer ${g.auction_count === 1 ? 'includes' : 'include'} this group: check who can see ${g.auction_count === 1 ? 'it' : 'them'}.`);
  if (g.price_count) notes.push(`${plural(g.price_count, 'group start price')} ${g.price_count === 1 ? 'was' : 'were'} removed.`);
  if (g.code_count) notes.push(`${plural(g.code_count, 'sign-up code')} no longer ${g.code_count === 1 ? 'adds' : 'add'} bidders to a group.`);
  req.flash('ok', `Group "${g.name}" deleted. ${notes.join(' ')}`.trim());
  res.redirect('/admin/groups');
}));

module.exports = router;
module.exports.defaults = defaults;
