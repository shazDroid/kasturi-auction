const express = require('express');
const db = require('../../db');
const { clean, isEmail } = require('../../lib/util');
const { wrap, audit, upload, isImage } = require('../../middleware');
const { notFound } = require('./helpers');
const M = require('./media-helpers');

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

const form = (res, seller, v, errors = {}, auctions) => res.adminPage('admin/seller_form', {
  title: seller ? `Edit ${seller.name}` : 'New seller', seller, v: { logo_id: seller ? seller.logo_id : null, ...v }, errors, auctions, scripts: ['/js/admin.js'],
});

/** Check and store an uploaded logo. Returns { id } (null when none chosen) or sets errors.logo. */
async function readLogo(req, errors) {
  if (M.rejectedNames(req, 'logo').length || (req.file && !isImage(req.file))) {
    errors.logo = 'The logo must be a JPG, PNG or WebP image. Export it from the PDF or vector file as PNG first.';
    return { id: null };
  }
  if (!req.file || Object.keys(errors).length) return { id: null };
  const r = await M.storeImage(req.file);
  if (r.error) { errors.logo = r.error; return { id: null }; }
  return { id: r.id };
}

router.get('/sellers/new', (req, res) => form(res, null, { active: true }));

router.post('/sellers', M.uploads(upload.single('logo')), wrap(async (req, res) => {
  if (req.uploadError) { req.flash('error', `${req.uploadError} The seller was not saved.`); return res.redirect('/admin/sellers/new'); }
  const { v, e } = read(req.body);
  const logo = await readLogo(req, e);
  if (Object.keys(e).length) return form(res, null, v, e);
  const row = await db.one(`INSERT INTO sellers(${COLS.join(',')}, logo_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [...COLS.map((k) => v[k]), logo.id]);
  audit(req, 'seller.create', `#${row.id} ${v.name}`);
  req.flash('ok', `Seller "${v.name}" added.`);
  res.redirect('/admin/sellers');
}));

router.get('/sellers/:id(\\d+)/edit', wrap(async (req, res) => {
  const s = await db.one(`SELECT s.*, (SELECT count(*)::int FROM auctions a WHERE a.seller_id = s.id) AS auction_count FROM sellers s WHERE id = $1`, [req.params.id]);
  if (!s) return notFound(res, 'This seller');
  const auctions = await db.many(`SELECT id, title, starts_at, status FROM auctions WHERE seller_id = $1 ORDER BY starts_at DESC LIMIT 20`, [s.id]);
  form(res, s, s, {}, auctions);
}));

router.post('/sellers/:id(\\d+)', M.uploads(upload.single('logo')), wrap(async (req, res) => {
  const s = await db.one(`SELECT s.*, (SELECT count(*)::int FROM auctions a WHERE a.seller_id = s.id) AS auction_count FROM sellers s WHERE id = $1`, [req.params.id]);
  if (!s) return notFound(res, 'This seller');
  if (req.uploadError) { req.flash('error', `${req.uploadError} The seller was not saved.`); return res.redirect(`/admin/sellers/${s.id}/edit`); }
  const { v, e } = read(req.body);
  const logo = await readLogo(req, e);
  if (Object.keys(e).length) return form(res, s, { ...v, remove_logo: req.body.remove_logo === '1' }, e);
  const logoId = logo.id || (req.body.remove_logo === '1' ? null : s.logo_id);
  await db.query(`UPDATE sellers SET ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, logo_id = $${COLS.length + 2} WHERE id = $1`, [s.id, ...COLS.map((k) => v[k]), logoId]);
  if (s.logo_id && s.logo_id !== logoId) await M.deleteFilesIfUnused([s.logo_id]);
  audit(req, 'seller.update', `#${s.id} ${v.name}${logoId !== s.logo_id ? (logoId ? ', logo updated' : ', logo removed') : ''}`);
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
  if (s.logo_id) await M.deleteFilesIfUnused([s.logo_id]);
  audit(req, 'seller.delete', `#${s.id} ${s.name}`);
  req.flash('ok', `Seller "${s.name}" deleted.`);
  res.redirect('/admin/sellers');
}));

module.exports = router;
