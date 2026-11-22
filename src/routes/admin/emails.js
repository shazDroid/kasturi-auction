// Email templates, broadcasts and the email log.
const express = require('express');
const db = require('../../db');
const mailer = require('../../lib/mailer');
const { clean, toInt, nl2p, escapeHtml, fmtDT, fmtINR, fmtDate } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { paginate, notFound, allowSelfFrames, emailPreviewHeaders } = require('./helpers');

const router = express.Router();
const ALWAYS = ['site_name', 'site_url', 'contact_email', 'contact_phone'];

/** Realistic values for every template variable, used by previews and test sends. */
function sampleVars() {
  const start = new Date(Date.now() + 3 * 86400000);
  return {
    name: 'Ramesh Patil', bidder_name: 'Ramesh Patil', company: 'Patil Metal Traders', bidder_no: 'KA-00042',
    email: 'ramesh@patilmetal.example', phone: '+91 98220 12345',
    verify_url: mailer.url('/verify/sample-token'), reset_url: mailer.url('/reset-password/sample-token'),
    account_url: mailer.url('/account'), admin_url: mailer.url('/admin/bidders/42'),
    reason: 'The GST certificate is not readable. Upload a clear scan of all pages.',
    base_amount: fmtINR(5000), tax_amount: fmtINR(900), amount: fmtINR(5900), payment_ref: 'pay_P8sX2kLmQ1aBcD',
    paid_on: fmtDate(new Date()), valid_until: fmtDate(new Date(Date.now() + 365 * 86400000)),
    auction_title: 'HMS 1 and 2 melting scrap, Chakan plant', seller_name: 'Deccan Forgings Ltd', location: 'Chakan, Pune',
    starts_at: fmtDT(start), ends_at: fmtDT(new Date(start.getTime() + 3 * 3600000)), lot_count: 6,
    auction_url: mailer.url('/auctions/1'), lot_no: 3, lot_title: 'CRC sheet cuttings', quantity: '24.5 MT',
    your_bid: fmtINR(41500), winning_bid: fmtINR(42300),
    message: 'We would like to inspect the turning scrap lot before the auction. Is Saturday possible?',
  };
}

const varsOf = (t) => String(t.variables || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

/** Make sure every default template exists (the seed normally does this). */
async function ensureTemplates() {
  for (const t of mailer.DEFAULT_TEMPLATES) {
    await db.query(
      `INSERT INTO email_templates(key, name, description, variables, subject, body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
      [t.key, t.name, t.description, t.variables, t.subject, t.body]
    );
  }
}

// ---------- Templates ----------
router.get('/emails/templates', wrap(async (req, res) => {
  await ensureTemplates();
  const order = mailer.DEFAULT_TEMPLATES.map((t) => t.key);
  const rows = (await db.many('SELECT key, name, description, subject, enabled, updated_at FROM email_templates'))
    .sort((a, b) => (order.indexOf(a.key) + 1 || 999) - (order.indexOf(b.key) + 1 || 999));
  res.adminPage('admin/email_templates', { title: 'Email templates', rows, transport: mailer.transportName() });
}));

const loadTemplate = (key) => db.one('SELECT * FROM email_templates WHERE key = $1', [String(key)]);

router.get('/emails/templates/:key', wrap(async (req, res) => {
  const t = await loadTemplate(req.params.key);
  if (!t) return notFound(res, 'This email template');
  allowSelfFrames(res);
  res.adminPage('admin/email_template', {
    title: t.name, t, vars: varsOf(t), always: ALWAYS, hasDefault: mailer.DEFAULT_TEMPLATES.some((d) => d.key === t.key),
    scripts: ['/js/admin.js'],
  });
}));

router.get('/emails/templates/:key/preview', wrap(async (req, res) => {
  const r = await mailer.render(String(req.params.key), sampleVars());
  if (!r) return res.status(404).end();
  emailPreviewHeaders(res);
  res.send(r.html);
}));

// Unsaved edits, posted by admin.js into the preview iframe.
router.post('/emails/templates/:key/preview', (req, res) => {
  const r = mailer.renderString(clean(req.body.subject, 300), String(req.body.body || '').slice(0, 100000), sampleVars());
  emailPreviewHeaders(res);
  res.send(r.html);
});

router.post('/emails/templates/:key', wrap(async (req, res) => {
  const t = await loadTemplate(req.params.key);
  if (!t) return notFound(res, 'This email template');
  const subject = clean(req.body.subject, 300);
  const body = String(req.body.body || '').trim().slice(0, 100000);
  const enabled = req.body.enabled === '1';
  if (!subject || !body) {
    req.flash('error', 'The subject and the body cannot be empty. Use "Restore default" to start again from the original text.');
    return res.redirect(`/admin/emails/templates/${t.key}`);
  }
  await db.query('UPDATE email_templates SET subject = $2, body = $3, enabled = $4, updated_at = now() WHERE key = $1', [t.key, subject, body, enabled]);
  audit(req, 'email_template.update', `${t.key}${enabled !== t.enabled ? (enabled ? ' (enabled)' : ' (disabled)') : ''}`);
  req.flash('ok', `Template "${t.name}" saved.${enabled ? '' : ' It is turned off, so this email is not sent.'}`);
  res.redirect(`/admin/emails/templates/${t.key}`);
}));

router.post('/emails/templates/:key/toggle', wrap(async (req, res) => {
  const t = await db.one('UPDATE email_templates SET enabled = NOT enabled, updated_at = now() WHERE key = $1 RETURNING key, name, enabled', [String(req.params.key)]);
  if (!t) return notFound(res, 'This email template');
  audit(req, 'email_template.toggle', `${t.key} ${t.enabled ? 'enabled' : 'disabled'}`);
  req.flash('ok', `"${t.name}" is ${t.enabled ? 'turned on' : 'turned off and will not be sent'}.`);
  res.redirect('/admin/emails/templates');
}));

router.post('/emails/templates/:key/test', wrap(async (req, res) => {
  const t = await loadTemplate(req.params.key);
  if (!t) return notFound(res, 'This email template');
  const r = mailer.renderString(t.subject, t.body, sampleVars());
  // Queued directly so a test also works while the template is turned off.
  await db.query(`INSERT INTO email_log(to_email, subject, html, template_key, status) VALUES($1,$2,$3,$4,'queued')`,
    [req.admin.email, `[Test] ${r.subject}`, r.html, t.key]);
  audit(req, 'email_template.test', `${t.key} to ${req.admin.email}`);
  const tr = mailer.transportName();
  req.flash(tr === 'none' ? 'info' : 'ok', tr === 'none'
    ? `Test queued to ${req.admin.email}, but no mail provider is connected, so it will be logged as skipped.`
    : `Test email queued to ${req.admin.email} with sample details. It arrives within a minute.`);
  res.redirect(`/admin/emails/templates/${t.key}`);
}));

router.post('/emails/templates/:key/restore', wrap(async (req, res) => {
  const d = mailer.DEFAULT_TEMPLATES.find((x) => x.key === req.params.key);
  if (!d) return notFound(res, 'The default for this template');
  await db.query(
    `UPDATE email_templates SET name = $2, description = $3, variables = $4, subject = $5, body = $6, updated_at = now() WHERE key = $1`,
    [d.key, d.name, d.description, d.variables, d.subject, d.body]
  );
  audit(req, 'email_template.restore', d.key);
  req.flash('ok', `"${d.name}" restored to the original wording.`);
  res.redirect(`/admin/emails/templates/${d.key}`);
}));

// ---------- Broadcast ----------
const AUDIENCES = {
  verified: 'All bidders with a verified email',
  approved: 'Approved bidders',
  documents: 'Bidders who have not submitted documents or were rejected',
  review: 'Bidders whose documents are awaiting review',
  unpaid: 'Bidders who have not paid the registration fee',
  auction: 'Bidders who bid in a chosen auction',
};

async function recipients(aud, auctionId) {
  const base = 'SELECT u.id, u.name, u.email FROM users u WHERE NOT u.blocked AND NOT u.email_opt_out';
  switch (aud) {
    case 'verified': return db.many(`${base} AND u.email_verified ORDER BY u.id`);
    case 'approved': return db.many(`${base} AND u.kyc_status = 'approved' ORDER BY u.id`);
    case 'documents': return db.many(`${base} AND u.kyc_status IN ('incomplete','rejected') ORDER BY u.id`);
    case 'review': return db.many(`${base} AND u.kyc_status = 'pending' ORDER BY u.id`);
    case 'unpaid': return db.many(`${base} AND (u.fee_paid_until IS NULL OR u.fee_paid_until <= now()) ORDER BY u.id`);
    case 'auction': return auctionId ? db.many(
      `${base} AND EXISTS (SELECT 1 FROM bids b JOIN lots l ON l.id = b.lot_id WHERE b.user_id = u.id AND l.auction_id = $1) ORDER BY u.id`, [auctionId]
    ) : [];
    default: return [];
  }
}

async function renderBroadcast(req, res, v, error = '') {
  const auctions = await db.many(`SELECT id, title, starts_at FROM auctions WHERE status <> 'draft' ORDER BY starts_at DESC LIMIT 100`);
  let count = null;
  if (AUDIENCES[v.audience]) count = (await recipients(v.audience, v.auction_id)).length;
  res.adminPage('admin/broadcast', { title: 'Send a broadcast', v, AUDIENCES, auctions, count, error, transport: mailer.transportName(), scripts: ['/js/admin.js'] });
}

router.get('/emails/broadcast', wrap(async (req, res) => {
  await renderBroadcast(req, res, {
    audience: AUDIENCES[req.query.audience] ? req.query.audience : '',
    auction_id: toInt(req.query.auction_id, 0) || null,
    subject: clean(req.query.subject, 200), message: '',
  });
}));

router.post('/emails/broadcast', wrap(async (req, res) => {
  const v = {
    audience: AUDIENCES[req.body.audience] ? req.body.audience : '',
    auction_id: toInt(req.body.auction_id, 0) || null,
    subject: clean(req.body.subject, 200),
    message: clean(req.body.message, 20000),
  };
  let error = '';
  if (!v.audience) error = 'Choose who should receive this email.';
  else if (v.audience === 'auction' && !v.auction_id) error = 'Choose the auction whose bidders should receive this email.';
  else if (!v.subject || !v.message) error = 'Enter both a subject and a message.';
  else if (req.body.confirm !== '1') error = 'Tick the confirmation box to send.';
  if (error) return renderBroadcast(req, res, v, error);
  const list = await recipients(v.audience, v.auction_id);
  if (!list.length) return renderBroadcast(req, res, v, 'Nobody matches this audience, so nothing was sent.');
  const fillName = (s, u) => s.replace(/\{\{\s*name\s*\}\}/g, u.name);
  for (const u of list) {
    await mailer.sendRaw(u.email, fillName(v.subject, u), nl2p(fillName(v.message, u)), 'broadcast');
  }
  audit(req, 'email.broadcast', `${AUDIENCES[v.audience]}${v.auction_id ? ` (auction #${v.auction_id})` : ''}: "${v.subject}" to ${list.length}`);
  req.flash('ok', `Broadcast queued for ${list.length} recipient${list.length === 1 ? '' : 's'}. Track delivery in the email log.`);
  res.redirect('/admin/emails/log?template=broadcast');
}));

// ---------- Log ----------
const LOG_STATUSES = ['queued', 'sent', 'failed', 'skipped'];

router.get('/emails/log', wrap(async (req, res) => {
  const f = {
    status: LOG_STATUSES.includes(req.query.status) ? req.query.status : '',
    q: clean(req.query.q, 100),
    template: clean(req.query.template, 60),
  };
  const where = `WHERE ($1 = '' OR status = $1) AND ($2 = '' OR to_email ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%')
                   AND ($3 = '' OR template_key = $3)`;
  const params = [f.status, f.q, f.template];
  const { n } = await db.one(`SELECT count(*)::int AS n FROM email_log ${where}`, params);
  const pg = paginate(n, req.query.page, 50);
  const rows = await db.many(
    `SELECT id, to_email, subject, template_key, status, error, attempts, created_at, sent_at FROM email_log ${where}
      ORDER BY id DESC LIMIT $4 OFFSET $5`, [...params, pg.per, pg.offset]
  );
  const templates = await db.many('SELECT key, name FROM email_templates ORDER BY name');
  res.adminPage('admin/email_log', { title: 'Email log', rows, pg, f, LOG_STATUSES, templates, transport: mailer.transportName() });
}));

router.get('/emails/log/:id(\\d+)', wrap(async (req, res) => {
  const m = await db.one('SELECT id, to_email, subject, template_key, status, error, attempts, created_at, sent_at FROM email_log WHERE id = $1', [req.params.id]);
  if (!m) return notFound(res, 'This email');
  const t = m.template_key ? await db.one('SELECT name FROM email_templates WHERE key = $1', [m.template_key]) : null;
  allowSelfFrames(res);
  res.adminPage('admin/email_view', { title: m.subject || 'Email', m, templateName: t ? t.name : '' });
}));

router.get('/emails/log/:id(\\d+)/html', wrap(async (req, res) => {
  const m = await db.one('SELECT html FROM email_log WHERE id = $1', [req.params.id]);
  if (!m) return res.status(404).end();
  emailPreviewHeaders(res);
  res.send(m.html || `<p>${escapeHtml('This email has no body.')}</p>`);
}));

router.post('/emails/log/:id(\\d+)/retry', wrap(async (req, res) => {
  const m = await db.one(
    `UPDATE email_log SET status = 'queued', attempts = 0, error = '' WHERE id = $1 AND status IN ('failed','skipped') RETURNING id, to_email`, [req.params.id]
  );
  if (!m) req.flash('error', 'Only failed or skipped emails can be sent again.');
  else {
    audit(req, 'email.retry', `#${m.id} to ${m.to_email}`);
    req.flash('ok', `Email to ${m.to_email} queued again.`);
  }
  res.redirect(String(req.body.back || '').startsWith('/admin/emails/log') ? req.body.back : `/admin/emails/log/${req.params.id}`);
}));

router.post('/emails/log/retry-failed', wrap(async (req, res) => {
  const r = await db.query(`UPDATE email_log SET status = 'queued', attempts = 0, error = '' WHERE status = 'failed' AND created_at > now() - interval '7 days'`);
  audit(req, 'email.retry_failed', `${r.rowCount} emails`);
  req.flash('ok', r.rowCount ? `${r.rowCount} failed email${r.rowCount === 1 ? '' : 's'} from the last 7 days queued again.` : 'There are no failed emails from the last 7 days.');
  res.redirect('/admin/emails/log');
}));

module.exports = router;
