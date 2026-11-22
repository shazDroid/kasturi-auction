const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const settings = require('../lib/settings');
const mailer = require('../lib/mailer');
const { clean, isEmail, token } = require('../lib/util');
const { wrap, requireUser } = require('../middleware');

const router = express.Router();

const BCRYPT_COST = 11;
// Compared against when the email is unknown, so response time does not reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);
const normEmail = (s) => clean(s, 200).toLowerCase();
const phoneOk = (s) => /^\+?[0-9]{10,13}$/.test(String(s || '').replace(/[\s\-()]/g, ''));
/** Only local paths are allowed as a post-login destination. */
const safePath = (p) => (typeof p === 'string' && /^\/(?!\/)/.test(p) && !p.startsWith('/\\') ? p : null);

/** Replace the session (prevents fixation) and sign the bidder in. Nothing else is carried over. */
const signIn = (req, userId) => new Promise((resolve, reject) => {
  req.session.regenerate((err) => {
    if (err) return reject(err);
    req.session.userId = userId;
    resolve();
  });
});

const tooMany = (view, extra) => (req, res) => {
  res.status(429);
  res.page(view, { fullBleed: true,
    title: extra.title, values: { email: clean(req.body && req.body.email, 200) }, errors: {},
    formError: extra.message,
  });
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: tooMany('site/login', { title: 'Sign in', message: 'Too many sign-in attempts from this connection. Wait 15 minutes and try again, or reset your password.' }),
});
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: tooMany('site/forgot', { title: 'Reset your password', message: 'Too many reset requests from this connection. Wait 15 minutes and try again.' }),
});
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => 'resend:' + req.user.id,
  handler: (req, res) => {
    req.flash('error', 'We have already sent several verification emails. Check your spam folder, or wait 15 minutes and try again.');
    res.redirect('/account');
  },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('error', { title: 'Too many registrations', message: 'Too many accounts were created from this connection. Try again in an hour or contact support.' });
  },
});

async function sendVerification(user) {
  await mailer.send('verify_email', user.email, { name: user.name, verify_url: mailer.url('/verify/' + user.verify_token) });
}

/* ---------------- Register ---------------- */

const blankRegister = { name: '', email: '', phone: '', company_name: '', business_type: '', accept: false };

function renderRegister(res, values, errors, status = 200) {
  res.status(status);
  res.page('site/register', { fullBleed: true,
    title: 'Register as a bidder',
    open: settings.bool('registration_open'),
    businessTypes: settings.list('business_types'),
    values, errors,
  });
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/account');
  renderRegister(res, blankRegister, {});
});

router.post('/register', registerLimiter, wrap(async (req, res) => {
  if (!settings.bool('registration_open')) return renderRegister(res, blankRegister, {}, 403);
  const b = req.body || {};
  const v = {
    name: clean(b.name, 100),
    email: normEmail(b.email),
    phone: clean(b.phone, 20),
    company_name: clean(b.company_name, 150),
    business_type: clean(b.business_type, 60),
    accept: b.accept === '1',
  };
  const password = String(b.password || '');
  const confirm = String(b.confirm || '');
  const types = settings.list('business_types');
  const e = {};
  if (v.name.length < 2) e.name = 'Enter your full name.';
  if (!isEmail(v.email)) e.email = 'Enter a valid email address, for example name@company.com.';
  if (!phoneOk(v.phone)) e.phone = 'Enter a 10 digit mobile number. You can add +91 in front.';
  if (v.company_name.length < 2) e.company_name = 'Enter the name of your company or firm.';
  if (types.length && !types.includes(v.business_type)) e.business_type = 'Choose the option that best describes your business.';
  if (password.length < 8) e.password = 'Use at least 8 characters.';
  else if (password.length > 200) e.password = 'Use at most 200 characters.';
  if (!e.password && confirm !== password) e.confirm = 'The two passwords do not match.';
  if (!v.accept) e.accept = 'You need to accept the terms and conditions to register.';
  if (!e.email && await db.one('SELECT 1 FROM users WHERE lower(email) = $1', [v.email])) {
    e.email = 'An account with this email already exists. Sign in, or reset the password if you have forgotten it.';
  }
  if (Object.keys(e).length) return renderRegister(res, v, e, 422);

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  let user;
  try {
    user = await db.one(
      `INSERT INTO users(email, password_hash, name, phone, company_name, business_type, verify_token)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [v.email, hash, v.name, v.phone, v.company_name, v.business_type, token()]
    );
  } catch (err) {
    if (err.code === '23505') {
      return renderRegister(res, v, { email: 'An account with this email already exists. Sign in, or reset the password if you have forgotten it.' }, 422);
    }
    throw err;
  }
  await sendVerification(user).catch((err) => console.error('verify mail', err.message));
  await signIn(req, user.id);
  req.flash('ok', `Your account is ready. We have sent a verification link to ${user.email}.`);
  res.redirect('/account');
}));

/* ---------------- Email verification ---------------- */

router.get('/verify/:token', wrap(async (req, res) => {
  const t = String(req.params.token || '');
  const user = t.length >= 16
    ? await db.one(`UPDATE users SET email_verified = true, verify_token = NULL WHERE verify_token = $1 RETURNING *`, [t])
    : null;
  if (!user) {
    req.flash('error', 'This verification link is not valid or has already been used. Sign in to send a new one.');
    return res.redirect(req.user ? '/account' : '/login');
  }
  await mailer.send('welcome', user.email, { name: user.name, account_url: mailer.url('/account') }).catch((err) => console.error('welcome mail', err.message));
  req.flash('ok', 'Your email address is verified.');
  res.redirect(req.user ? '/account' : '/login');
}));

router.post('/account/resend-verification', requireUser, resendLimiter, wrap(async (req, res) => {
  if (req.user.email_verified) {
    req.flash('info', 'Your email address is already verified.');
    return res.redirect('/account');
  }
  let tok = req.user.verify_token;
  if (!tok) {
    tok = token();
    await db.query('UPDATE users SET verify_token = $2 WHERE id = $1', [req.user.id, tok]);
  }
  await sendVerification({ ...req.user, verify_token: tok });
  req.flash('ok', `We have sent a new verification link to ${req.user.email}. It can take a few minutes to arrive.`);
  res.redirect('/account');
}));

/* ---------------- Sign in / out ---------------- */

router.get('/login', (req, res) => {
  const next = safePath(req.query.next);
  if (next) req.session.returnTo = next;
  if (req.user) return res.redirect(next || '/account');
  res.page('site/login', { fullBleed: true, title: 'Sign in', values: { email: '' }, errors: {}, formError: '' });
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  const fail = (msg) => {
    res.status(422);
    res.page('site/login', { fullBleed: true, title: 'Sign in', values: { email }, errors: {}, formError: msg });
  };
  const user = email ? await db.one('SELECT id, password_hash, blocked FROM users WHERE lower(email) = $1', [email]) : null;
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return fail('Email or password is incorrect.');
  if (user.blocked) return fail('This account is suspended. Contact support.');

  const returnTo = safePath(req.session.returnTo);
  await signIn(req, user.id);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  res.redirect(returnTo || '/account');
}));

router.post('/logout', (req, res) => {
  delete req.session.userId;
  delete req.session.returnTo;
  req.flash('info', 'You have signed out.');
  res.redirect('/');
});

/* ---------------- Password reset ---------------- */

router.get('/forgot-password', (req, res) => {
  res.page('site/forgot', { fullBleed: true, title: 'Reset your password', values: { email: '' }, errors: {}, formError: '' });
});

router.post('/forgot-password', forgotLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!isEmail(email)) {
    res.status(422);
    return res.page('site/forgot', { fullBleed: true, title: 'Reset your password', values: { email }, errors: { email: 'Enter the email address you registered with.' }, formError: '' });
  }
  const tok = token();
  const user = await db.one(
    `UPDATE users SET reset_token = $2, reset_expires = now() + interval '1 hour'
      WHERE lower(email) = $1 AND NOT blocked RETURNING name, email`, [email, tok]
  );
  if (user) {
    await mailer.send('password_reset', user.email, { name: user.name, reset_url: mailer.url('/reset-password/' + tok) })
      .catch((err) => console.error('reset mail', err.message));
  }
  // Same answer either way, so this form cannot be used to find out who has an account.
  req.flash('ok', `If ${email} has an account with us, we have emailed a link to reset the password. The link works for 1 hour.`);
  res.redirect('/forgot-password');
}));

const findReset = (t) => (String(t || '').length >= 16
  ? db.one('SELECT id, email FROM users WHERE reset_token = $1 AND reset_expires > now()', [String(t)])
  : null);

router.get('/reset-password/:token', wrap(async (req, res) => {
  const user = await findReset(req.params.token);
  res.status(user ? 200 : 410);
  res.page('site/reset', { fullBleed: true, title: 'Choose a new password', valid: !!user, token: req.params.token, errors: {} });
}));

router.post('/reset-password/:token', wrap(async (req, res) => {
  const user = await findReset(req.params.token);
  if (!user) {
    res.status(410);
    return res.page('site/reset', { fullBleed: true, title: 'Choose a new password', valid: false, token: '', errors: {} });
  }
  const password = String(req.body.password || '');
  const e = {};
  if (password.length < 8) e.password = 'Use at least 8 characters.';
  else if (password.length > 200) e.password = 'Use at most 200 characters.';
  else if (String(req.body.confirm || '') !== password) e.confirm = 'The two passwords do not match.';
  if (Object.keys(e).length) {
    res.status(422);
    return res.page('site/reset', { fullBleed: true, title: 'Choose a new password', valid: true, token: req.params.token, errors: e });
  }
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  // The link proves the bidder can read this inbox, so the email counts as verified too.
  await db.query(
    `UPDATE users SET password_hash = $2, reset_token = NULL, reset_expires = NULL, email_verified = true, verify_token = NULL WHERE id = $1`,
    [user.id, hash]
  );
  req.flash('ok', 'Your password has been changed. Sign in with the new password.');
  res.redirect('/login');
}));

module.exports = router;
