// Admin users and the activity log.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const { clean, isEmail, toInt } = require('../../lib/util');
const { wrap, audit, requireSuperadmin } = require('../../middleware');
const { paginate, notFound } = require('./helpers');

const router = express.Router();
const ROLES = ['staff', 'superadmin'];
const hash = (p) => bcrypt.hash(p, 11);
const passwordError = (p) => (String(p || '').length < 8 ? 'Use at least 8 characters.' : '');

router.get('/team', wrap(async (req, res) => {
  const rows = await db.many('SELECT id, name, email, role, active, last_login_at, created_at FROM admins ORDER BY active DESC, name');
  res.adminPage('admin/team', { title: 'Admin users', rows, isSuper: req.admin.role === 'superadmin' });
}));

// ---------- Own account ----------
router.get('/team/me', (req, res) => res.adminPage('admin/team_me', { title: 'My account', errors: {}, v: { name: req.admin.name } }));

router.post('/team/me', wrap(async (req, res) => {
  const me = await db.one('SELECT * FROM admins WHERE id = $1', [req.admin.id]);
  const v = { name: clean(req.body.name, 200) };
  const errors = {};
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (!v.name) errors.name = 'Enter your name.';
  if (next || current) {
    if (!(await bcrypt.compare(current, me.password_hash))) errors.current_password = 'Your current password is not correct.';
    if (passwordError(next)) errors.new_password = passwordError(next);
    else if (next !== String(req.body.confirm_password || '')) errors.confirm_password = 'The two new passwords do not match.';
  }
  if (Object.keys(errors).length) return res.adminPage('admin/team_me', { title: 'My account', errors, v });
  await db.query('UPDATE admins SET name = $2 WHERE id = $1', [me.id, v.name]);
  if (next) await db.query('UPDATE admins SET password_hash = $2 WHERE id = $1', [me.id, await hash(next)]);
  audit(req, next ? 'admin.password_change' : 'admin.profile_update', me.email);
  req.flash('ok', next ? 'Your password has been changed.' : 'Your details have been saved.');
  res.redirect('/admin/team/me');
}));

// ---------- Superadmin only ----------
const activeSupers = (exceptId) => db.one(
  `SELECT count(*)::int AS n FROM admins WHERE active AND role = 'superadmin' AND id <> $1`, [exceptId]
).then((r) => r.n);

const form = (res, a, v, errors = {}) => res.adminPage('admin/team_form', { title: a ? `Edit ${a.name}` : 'Add admin user', a, v, errors, ROLES });

router.get('/team/new', requireSuperadmin, (req, res) => form(res, null, { role: 'staff' }));

router.post('/team', requireSuperadmin, wrap(async (req, res) => {
  const v = { name: clean(req.body.name, 200), email: clean(req.body.email, 200).toLowerCase(), role: ROLES.includes(req.body.role) ? req.body.role : 'staff' };
  const password = String(req.body.password || '');
  const errors = {};
  if (!v.name) errors.name = 'Enter the person\'s name.';
  if (!isEmail(v.email)) errors.email = 'Enter a valid email address.';
  else if (await db.one('SELECT 1 FROM admins WHERE lower(email) = $1', [v.email])) errors.email = 'An admin user with this email already exists.';
  if (passwordError(password)) errors.password = passwordError(password);
  if (Object.keys(errors).length) return form(res, null, v, errors);
  const row = await db.one('INSERT INTO admins(name, email, role, password_hash) VALUES($1,$2,$3,$4) RETURNING id', [v.name, v.email, v.role, await hash(password)]);
  audit(req, 'admin.create', `#${row.id} ${v.email} (${v.role})`);
  req.flash('ok', `${v.name} can now sign in at /admin/login with the password you set. Ask them to change it from "My account".`);
  res.redirect('/admin/team');
}));

const loadAdmin = (id) => db.one('SELECT id, name, email, role, active, last_login_at, created_at FROM admins WHERE id = $1', [toInt(id, 0)]);

router.get('/team/:id(\\d+)/edit', requireSuperadmin, wrap(async (req, res) => {
  const a = await loadAdmin(req.params.id);
  if (!a) return notFound(res, 'This admin user');
  form(res, a, a);
}));

router.post('/team/:id(\\d+)', requireSuperadmin, wrap(async (req, res) => {
  const a = await loadAdmin(req.params.id);
  if (!a) return notFound(res, 'This admin user');
  const v = { name: clean(req.body.name, 200), email: clean(req.body.email, 200).toLowerCase(), role: ROLES.includes(req.body.role) ? req.body.role : 'staff' };
  const errors = {};
  if (!v.name) errors.name = 'Enter the person\'s name.';
  if (!isEmail(v.email)) errors.email = 'Enter a valid email address.';
  else if (await db.one('SELECT 1 FROM admins WHERE lower(email) = $1 AND id <> $2', [v.email, a.id])) errors.email = 'Another admin user has this email.';
  if (a.role === 'superadmin' && v.role !== 'superadmin') {
    if (a.id === req.admin.id) errors.role = 'You cannot remove your own super admin role. Ask another super admin.';
    else if (a.active && (await activeSupers(a.id)) === 0) errors.role = 'This is the last active super admin. Make someone else a super admin first.';
  }
  if (Object.keys(errors).length) return form(res, a, v, errors);
  await db.query('UPDATE admins SET name = $2, email = $3, role = $4 WHERE id = $1', [a.id, v.name, v.email, v.role]);
  audit(req, 'admin.update', `#${a.id} ${v.email} (${v.role})`);
  req.flash('ok', `${v.name} saved.`);
  res.redirect('/admin/team');
}));

router.post('/team/:id(\\d+)/active', requireSuperadmin, wrap(async (req, res) => {
  const a = await loadAdmin(req.params.id);
  if (!a) return notFound(res, 'This admin user');
  const active = req.body.active === '1';
  if (!active && a.id === req.admin.id) req.flash('error', 'You cannot deactivate your own account.');
  else if (!active && a.role === 'superadmin' && (await activeSupers(a.id)) === 0) req.flash('error', 'This is the last active super admin, so it cannot be deactivated.');
  else {
    await db.query('UPDATE admins SET active = $2 WHERE id = $1', [a.id, active]);
    audit(req, active ? 'admin.reactivate' : 'admin.deactivate', `#${a.id} ${a.email}`);
    req.flash('ok', active ? `${a.name} can sign in again.` : `${a.name} is deactivated and signed out.`);
  }
  res.redirect('/admin/team');
}));

router.post('/team/:id(\\d+)/password', requireSuperadmin, wrap(async (req, res) => {
  const a = await loadAdmin(req.params.id);
  if (!a) return notFound(res, 'This admin user');
  const p = String(req.body.password || '');
  if (passwordError(p)) {
    req.flash('error', 'The new password must be at least 8 characters.');
    return res.redirect(`/admin/team/${a.id}/edit`);
  }
  await db.query('UPDATE admins SET password_hash = $2 WHERE id = $1', [a.id, await hash(p)]);
  audit(req, 'admin.password_reset', `#${a.id} ${a.email}`);
  req.flash('ok', `Password for ${a.name} reset. Share it with them securely and ask them to change it.`);
  res.redirect('/admin/team');
}));

// ---------- Activity log ----------
router.get('/audit', wrap(async (req, res) => {
  const adminId = toInt(req.query.admin, 0) || null;
  const q = clean(req.query.q, 100);
  const where = `WHERE ($1::int IS NULL OR l.admin_id = $1) AND ($2 = '' OR l.action ILIKE '%' || $2 || '%' OR l.detail ILIKE '%' || $2 || '%')`;
  const { n } = await db.one(`SELECT count(*)::int AS n FROM audit_log l ${where}`, [adminId, q]);
  const pg = paginate(n, req.query.page, 50);
  const rows = await db.many(
    `SELECT l.*, a.name AS admin_name, a.email AS admin_email FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id ${where}
      ORDER BY l.id DESC LIMIT $3 OFFSET $4`, [adminId, q, pg.per, pg.offset]
  );
  const admins = await db.many('SELECT id, name FROM admins ORDER BY name');
  res.adminPage('admin/audit', { title: 'Activity log', rows, pg, admins, adminId, q });
}));

module.exports = router;
