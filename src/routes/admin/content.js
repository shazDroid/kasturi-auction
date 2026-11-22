// Enquiries from the contact form, and the editable site pages.
const express = require('express');
const db = require('../../db');
const { clean } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { paginate, notFound } = require('./helpers');

const router = express.Router();

// ---------- Enquiries ----------
router.get('/enquiries', wrap(async (req, res) => {
  const show = ['open', 'handled', 'all'].includes(req.query.show) ? req.query.show : 'all';
  const q = clean(req.query.q, 100);
  const where = `WHERE ($1 = 'all' OR handled = ($1 = 'handled'))
    AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%' OR company ILIKE '%' || $2 || '%' OR message ILIKE '%' || $2 || '%')`;
  const { n } = await db.one(`SELECT count(*)::int AS n FROM enquiries ${where}`, [show, q]);
  const pg = paginate(n, req.query.page, 50);
  const rows = await db.many(`SELECT * FROM enquiries ${where} ORDER BY handled, created_at DESC LIMIT $3 OFFSET $4`, [show, q, pg.per, pg.offset]);
  res.adminPage('admin/enquiries', { title: 'Enquiries', rows, pg, show, q });
}));

router.get('/enquiries/:id(\\d+)', wrap(async (req, res) => {
  const e = await db.one('SELECT * FROM enquiries WHERE id = $1', [req.params.id]);
  if (!e) return notFound(res, 'This enquiry');
  const bidder = await db.one('SELECT id, name, company_name FROM users WHERE lower(email) = lower($1)', [e.email]);
  res.adminPage('admin/enquiry', { title: `Enquiry from ${e.name}`, e, bidder });
}));

router.post('/enquiries/:id(\\d+)/handled', wrap(async (req, res) => {
  const handled = req.body.handled !== '0';
  const e = await db.one('UPDATE enquiries SET handled = $2 WHERE id = $1 RETURNING id, name', [req.params.id, handled]);
  if (!e) return notFound(res, 'This enquiry');
  audit(req, handled ? 'enquiry.handled' : 'enquiry.reopen', `#${e.id} ${e.name}`);
  req.flash('ok', handled ? `Enquiry from ${e.name} marked as handled.` : `Enquiry from ${e.name} reopened.`);
  res.redirect(handled ? '/admin/enquiries' : `/admin/enquiries/${e.id}`);
}));

router.post('/enquiries/:id(\\d+)/delete', wrap(async (req, res) => {
  const e = await db.one('DELETE FROM enquiries WHERE id = $1 RETURNING id, name, email', [req.params.id]);
  if (!e) return notFound(res, 'This enquiry');
  audit(req, 'enquiry.delete', `#${e.id} ${e.name} <${e.email}>`);
  req.flash('ok', `Enquiry from ${e.name} deleted.`);
  res.redirect('/admin/enquiries');
}));

// ---------- Pages ----------
router.get('/pages', wrap(async (req, res) => {
  const rows = await db.many('SELECT slug, title, length(body) AS size, updated_at FROM pages ORDER BY title');
  res.adminPage('admin/pages', { title: 'Pages', rows });
}));

const loadPage = (slug) => db.one('SELECT * FROM pages WHERE slug = $1', [String(slug)]);

router.get('/pages/:slug', wrap(async (req, res) => {
  const p = await loadPage(req.params.slug);
  if (!p) return notFound(res, 'This page');
  res.adminPage('admin/page_form', { title: `Edit ${p.title}`, p, v: p, errors: {} });
}));

router.post('/pages/:slug', wrap(async (req, res) => {
  const p = await loadPage(req.params.slug);
  if (!p) return notFound(res, 'This page');
  const v = { title: clean(req.body.title, 200), body: String(req.body.body || '').trim().slice(0, 150000) };
  const errors = {};
  if (!v.title) errors.title = 'Enter the page title.';
  if (Object.keys(errors).length) return res.adminPage('admin/page_form', { title: `Edit ${p.title}`, p, v, errors });
  await db.query('UPDATE pages SET title = $2, body = $3, updated_at = now() WHERE slug = $1', [p.slug, v.title, v.body]);
  audit(req, 'page.update', p.slug);
  req.flash('ok', `Page "${v.title}" saved.`);
  res.redirect(`/admin/pages/${encodeURIComponent(p.slug)}`);
}));

module.exports = router;
