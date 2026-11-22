// Admin panel. Mounted at /admin by server.js. Sign-in lives here; every other screen is in
// src/routes/admin/*.js and sits behind requireAdmin.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { clean } = require('../lib/util');
const { wrap, requireAdmin, audit } = require('../middleware');
const helpers = require('./admin/helpers');

const router = express.Router();

// Failed attempts render with 401 so only they count towards the limit.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).render('admin/login', {
    title: 'Admin sign in', email: clean(req.body && req.body.email, 200),
    error: 'Too many sign-in attempts from this network. Wait 15 minutes and try again.',
  }),
});

router.get('/login', (req, res) => {
  if (req.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin sign in', email: '', error: '' });
});

router.post('/login', loginLimiter, wrap(async (req, res, next) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const a = email ? await db.one('SELECT id, password_hash, active FROM admins WHERE lower(email) = $1', [email]) : null;
  const ok = a && a.active && password && await bcrypt.compare(password, a.password_hash);
  if (!ok) {
    return res.status(401).render('admin/login', {
      title: 'Admin sign in', email,
      error: a && !a.active ? 'This admin account has been deactivated. Ask a super admin to reactivate it.'
        : 'The email or password is not correct. Check both and try again.',
    });
  }
  const keepUser = req.session.userId;
  req.session.regenerate((err) => {
    if (err) return next(err);
    if (keepUser) req.session.userId = keepUser;
    req.session.adminId = a.id;
    db.query('UPDATE admins SET last_login_at = now() WHERE id = $1', [a.id])
      .then(() => db.query('INSERT INTO audit_log(admin_id, action, detail) VALUES($1,$2,$3)', [a.id, 'admin.login', email]))
      .then(() => req.session.save((e) => (e ? next(e) : res.redirect('/admin'))))
      .catch(next);
  });
}));

router.post('/logout', (req, res) => {
  if (req.admin) audit(req, 'admin.logout', req.admin.email);
  delete req.session.adminId;
  req.flash('ok', 'You have signed out of the admin panel.');
  res.redirect('/admin/login');
});

router.use(requireAdmin);

// Sidebar counters and view helpers for every admin page.
router.use(wrap(async (req, res, next) => {
  res.locals.adminNav = await db.one(
    `SELECT (SELECT count(*)::int FROM lots WHERE result = 'pending') AS "pendingResults",
            (SELECT count(*)::int FROM users WHERE kyc_status = 'pending') AS "pendingKyc",
            (SELECT count(*)::int FROM enquiries WHERE NOT handled) AS "openEnquiries"`
  );
  Object.assign(res.locals, helpers.viewHelpers(req));
  // Admin pages should never be cached by the browser or a proxy.
  res.set('Cache-Control', 'no-store');
  next();
}));

router.use(require('./admin/dashboard'));
router.use(require('./admin/auctions'));
router.use(require('./admin/results'));
router.use(require('./admin/sellers'));
router.use(require('./admin/bidders'));
router.use(require('./admin/payments'));
router.use(require('./admin/emails'));
router.use(require('./admin/content'));
router.use(require('./admin/settings'));
router.use(require('./admin/team'));

module.exports = router;
