const express = require('express');
const db = require('../../db');
const { clean, isEmail } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { notFound } = require('./helpers');

const router = express.Router();
const COLS = ['name', 'location', 'description', 'contact_name', 'contact_email', 'contact_phone', 'active'];

router.get('/sellers', wrap(async (req, res) => {
  const q = clean(req.query.q, 100);
  const rows = await db.many(
    `SELECT s.*, (SELECT count(*)::int FROM auctions a WHERE a.seller_id = s.id) AS auction_count,
            (SELECT max(a.starts_at) FROM auctions a WHERE a.seller_id = s.id) AS last_auction
       FROM sellers s
      WHERE $1 = '' OR s.name ILIKE '%' || $1 || '%' OR s.location ILIKE '%' || $1 || '%' OR s.contact_name ILIKE '%' || $1 || '%'
      ORDER BY s.active DESC, s.name`, [q]
  );
  res.adminPage('admin/sellers', { title: 'Sellers', rows, q });
}));

function read(body) {
  const v = {
    name: clean(body.name, 200), location: clean(body.location, 200), description: clean(body.description, 5000),
    contact_name: clean(body.contact_name, 200), contact_email: clean(body.contact_email, 200).toLowerCase(),
    contact_phone: clean(body.contact_phone, 50), active: body.active === '1',
  };
  const e = {};
  if (!v.name) e.name = 'Enter the seller name, for example the company or plant name.';
  if (v.contact_email && !isEmail(v.contact_email)) e.contact_email = 'Enter a valid email address, or leave it empty.';
  return { v, e };
}

const form = (res, seller, v, errors = {}) => res.adminPage('admin/seller_form', { title: seller ? `Edit ${seller.name}` : 'New seller', seller, v, errors });

router.get('/sellers/new', (req, res) => form(res, null, { active: true }));

router.post('/sellers', wrap(async (req, res) => {
  const { v, e } = read(req.body);
  if (Object.keys(e).length) return form(res, null, v, e);
  const row = await db.one(`INSERT INTO sellers(${COLS.join(',')}) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, COLS.map((k) => v[k]));
  audit(req, 'seller.create', `#${row.id} ${v.name}`);
  req.flash('ok', `Seller "${v.name}" added.`);
  res.redirect('/admin/sellers');
}));

router.get('/sellers/:id(\\d+)/edit', wrap(async (req, res) => {
  const s = await db.one(`SELECT s.*, (SELECT count(*)::int FROM auctions a WHERE a.seller_id = s.id) AS auction_count FROM sellers s WHERE id = $1`, [req.params.id]);
  if (!s) return notFound(res, 'This seller');
  const auctions = await db.many(`SELECT id, title, starts_at, status FROM auctions WHERE seller_id = $1 ORDER BY starts_at DESC LIMIT 20`, [s.id]);
  res.adminPage('admin/seller_form', { title: `Edit ${s.name}`, seller: s, v: s, errors: {}, auctions });
}));

router.post('/sellers/:id(\\d+)', wrap(async (req, res) => {
  const s = await db.one(`SELECT s.*, (SELECT count(*)::int FROM auctions a WHERE a.seller_id = s.id) AS auction_count FROM sellers s WHERE id = $1`, [req.params.id]);
  if (!s) return notFound(res, 'This seller');
  const { v, e } = read(req.body);
  if (Object.keys(e).length) return form(res, s, v, e);
  await db.query(`UPDATE sellers SET ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [s.id, ...COLS.map((k) => v[k])]);
  audit(req, 'seller.update', `#${s.id} ${v.name}`);
  req.flash('ok', `Seller "${v.name}" saved.`);
  res.redirect('/admin/sellers');
}));

router.post('/sellers/:id(\\d+)/delete', wrap(async (req, res) => {
  const s = await db.one(`SELECT s.*, (SELECT count(*)::int FROM auctions a WHERE a.seller_id = s.id) AS n FROM sellers s WHERE id = $1`, [req.params.id]);
  if (!s) return notFound(res, 'This seller');
  if (s.n > 0) {
    req.flash('error', `"${s.name}" has ${s.n} auction${s.n === 1 ? '' : 's'}, so it cannot be deleted. Mark it inactive instead.`);
    return res.redirect(`/admin/sellers/${s.id}/edit`);
  }
  await db.query('DELETE FROM sellers WHERE id = $1', [s.id]);
  audit(req, 'seller.delete', `#${s.id} ${s.name}`);
  req.flash('ok', `Seller "${s.name}" deleted.`);
  res.redirect('/admin/sellers');
}));

module.exports = router;
