const crypto = require('crypto');
const multer = require('multer');
const db = require('./db');
const settings = require('./lib/settings');
const util = require('./lib/util');
const bidding = require('./lib/bidding');

/** Wrap an async route so rejections reach the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Flash messages: req.flash('ok' | 'error' | 'info', text). Shown once on the next page. */
function flash(req, res, next) {
  req.flash = (type, text) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text });
  };
  res.locals.flash = req.session.flash || [];
  if (req.session.flash) delete req.session.flash;
  next();
}

/**
 * CSRF: one token per session. Forms send it as a hidden "_csrf" field; fetch() sends the
 * "x-csrf-token" header; multipart forms put it in the action URL (?_csrf=...) because the
 * body isn't parsed yet when this runs.
 */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || req.query._csrf || '');
  const ok = sent.length === req.session.csrf.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf));
  if (!ok) {
    if (req.xhr || (req.get('accept') || '').includes('json')) return res.status(403).json({ error: 'Your session expired. Reload the page and try again.' });
    return res.status(403).render('error', { title: 'Session expired', message: 'Your session expired. Go back, reload the page and try again.', layout: false });
  }
  next();
}

/** Loads the signed-in bidder and admin, and exposes helpers to every view. */
const context = wrap(async (req, res, next) => {
  req.user = null;
  req.admin = null;
  if (req.session.userId) {
    req.user = await db.one('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    if (!req.user || req.user.blocked) { delete req.session.userId; req.user = null; }
  }
  if (req.session.adminId) {
    req.admin = await db.one('SELECT id, name, email, role FROM admins WHERE id = $1 AND active', [req.session.adminId]);
    if (!req.admin) delete req.session.adminId;
  }
  Object.assign(res.locals, util, {
    S: settings.all(),
    user: req.user,
    admin: req.admin,
    eligibility: req.user ? bidding.eligibility(req.user) : null,
    path: req.path,
    query: req.query,
    razorpayKey: process.env.RAZORPAY_KEY_ID || '',
    title: '',
  });
  next();
});

/**
 * res.page(view, data): render a view inside the site layout.
 * res.adminPage(view, data): same, inside the admin layout.
 */
function pages(req, res, next) {
  const renderIn = (layout) => (view, data = {}) => {
    res.render(view, data, (err, body) => {
      if (err) return next(err);
      res.render(layout, { ...data, body });
    });
  };
  res.page = renderIn('layout');
  res.adminPage = renderIn('admin/layout');
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  if ((req.get('accept') || '').includes('json')) return res.status(401).json({ error: 'Sign in to continue.' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.admin) return next();
  res.redirect('/admin/login');
}

function requireSuperadmin(req, res, next) {
  if (req.admin && req.admin.role === 'superadmin') return next();
  req.flash('error', 'Only a super admin can do that.');
  res.redirect('/admin');
}

/** Record an admin action in the audit log. */
const audit = (req, action, detail = '') =>
  db.query('INSERT INTO audit_log(admin_id, action, detail) VALUES($1,$2,$3)', [req.admin ? req.admin.id : null, action, String(detail).slice(0, 1000)]).catch(() => {});

const ALLOWED_UPLOADS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
/** Multer instance: files kept in memory (max 5 MB, PDF/JPG/PNG/WebP) and then stored in Postgres via saveFile(). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_UPLOADS.includes(file.mimetype)),
});

/** Store an uploaded multer file in the files table; returns the new file id. */
async function saveFile(file) {
  const row = await db.one('INSERT INTO files(filename, mime, size, data) VALUES($1,$2,$3,$4) RETURNING id',
    [util.clean(file.originalname, 200), file.mimetype, file.size, file.buffer]);
  return row.id;
}

/** Stream a stored file to the response. inline=false forces a download. */
async function sendFile(res, fileId, { inline = true } = {}) {
  const f = await db.one('SELECT filename, mime, data FROM files WHERE id = $1', [fileId]);
  if (!f) return res.status(404).end();
  res.set('Content-Type', f.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(f.data);
}

module.exports = { wrap, flash, csrf, context, pages, requireUser, requireAdmin, requireSuperadmin, audit, upload, saveFile, sendFile };
