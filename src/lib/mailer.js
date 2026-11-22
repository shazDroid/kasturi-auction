/**
 * Email: admin-editable templates, one shared HTML layout, and a queue in email_log.
 *
 * Callers only ever queue mail (send / sendRaw / notifyAdmin). The worker calls processQueue()
 * every few seconds to deliver it, so a slow or broken mail provider never blocks a request
 * and never throws into the caller.
 */
const nodemailer = require('nodemailer');
const db = require('../db');
const settings = require('./settings');
const { escapeHtml, isEmail } = require('./util');

const BATCH = 20;
const MAX_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 20000;

const C = { page: '#f2f4f7', navy: '#0f2136', amber: '#f0a202', muted: '#56677a', line: '#dde2e8' };
const FONT = 'Arial, Helvetica, sans-serif';

// ---------------------------------------------------------------------------------------------
// URLs

/** Absolute URL for a path on this site. url('') is the site root without a trailing slash. */
function url(path = '') {
  const base = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`)
    .replace(/\/+$/, '');
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** Variables every template can use. */
function autoVars() {
  return {
    site_name: settings.get('site_name') || 'Kasturi Auction',
    site_url: url(''),
    contact_email: settings.get('contact_email'),
    contact_phone: settings.get('contact_phone'),
  };
}

/** Replace {{var}} placeholders. Unknown placeholders become empty. */
function fill(text, vars, escape) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    // Escaped values keep their line breaks (enquiry messages, rejection reasons).
    return escape ? escapeHtml(v).replace(/\r?\n/g, '<br>') : String(v);
  });
}

const BTN_STYLE = `display:inline-block;background:${C.navy};color:#ffffff;font-family:${FONT};font-size:15px;`
  + 'font-weight:bold;line-height:20px;text-decoration:none;padding:12px 22px;border-radius:3px;';
const DETAILS_STYLE = `border-collapse:collapse;width:100%;margin:0 0 16px 0;font-family:${FONT};font-size:15px;color:${C.navy};`;
const TD_STYLE = `padding:8px 10px;border:1px solid ${C.line};vertical-align:top;`;

/**
 * Turn the few helper classes template authors may use into inline styles, because Gmail and
 * Outlook ignore <style> blocks in many cases:
 *   <a class="btn" href="...">Label</a>   a navy button
 *   <table class="details">               a bordered two-column table; its bare <td> cells get padding
 * Also gives bare <p> tags a consistent margin.
 */
function inlineStyles(html) {
  return html
    .replace(/class="btn"/g, `style="${BTN_STYLE}"`)
    .replace(/<table class="details">/g, `<table role="presentation" cellpadding="0" cellspacing="0" style="${DETAILS_STYLE}">`)
    .replace(/<td>/g, `<td style="${TD_STYLE}">`)
    .replace(/<p>/g, '<p style="margin:0 0 16px 0;">');
}

/** Wrap an inner HTML fragment in the standard email layout. */
function layout(innerHtml, subject) {
  const v = autoVars();
  const footer = settings.get('email_footer');
  const contact = [v.contact_email, v.contact_phone].filter(Boolean).map(escapeHtml).join(' | ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${escapeHtml(subject || v.site_name)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${C.line};">
    <tr><td style="background:${C.navy};padding:18px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="12" height="20" style="width:12px;height:20px;background:${C.amber};font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding-left:10px;font-family:${FONT};font-size:18px;font-weight:bold;color:#ffffff;">${escapeHtml(v.site_name)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px;font-family:${FONT};font-size:15px;line-height:23px;color:${C.navy};">
${inlineStyles(innerHtml)}
    </td></tr>
    <tr><td style="padding:18px 28px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">
      ${footer ? `<p style="margin:0 0 6px 0;">${escapeHtml(footer)}</p>` : ''}
      <p style="margin:0;">${escapeHtml(v.site_name)}${contact ? ' | ' + contact : ''}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** Render a subject and body (as stored in email_templates) with vars. Used for admin previews too. */
function renderString(subject, body, vars = {}) {
  const all = { ...autoVars(), ...vars };
  const s = fill(subject, all, false).replace(/[\r\n]+/g, ' ').trim();
  return { subject: s, html: layout(fill(body, all, true), s) };
}

const loadTemplate = (key) => db.one('SELECT subject, body, enabled FROM email_templates WHERE key = $1', [key]);

/** Render a stored template, or null if it does not exist. */
async function render(templateKey, vars = {}) {
  const t = await loadTemplate(templateKey);
  return t ? renderString(t.subject, t.body, vars) : null;
}

// ---------------------------------------------------------------------------------------------
// Queueing

async function enqueue(to, subject, html, templateKey) {
  const row = await db.one(
    `INSERT INTO email_log(to_email, subject, html, template_key, status) VALUES($1,$2,$3,$4,'queued') RETURNING id`,
    [to, subject, html, templateKey || null]
  );
  return row.id;
}

/**
 * Queue an email from a template. Resolves to the email_log id, or null when nothing was queued
 * (template missing or disabled, bad address, or an error, which is logged).
 */
async function send(templateKey, toEmail, vars = {}) {
  try {
    if (!isEmail(toEmail)) return null;
    const t = await loadTemplate(templateKey);
    if (!t || !t.enabled) return null;
    const r = renderString(t.subject, t.body, vars);
    return await enqueue(toEmail, r.subject, r.html, templateKey);
  } catch (e) {
    console.error(`[mailer] could not queue ${templateKey} to ${toEmail}:`, e.message);
    return null;
  }
}

/** Queue a one-off email. innerHtml is trusted HTML and is wrapped in the standard layout. */
async function sendRaw(toEmail, subject, innerHtml, templateKey) {
  try {
    if (!isEmail(toEmail)) return null;
    const s = String(subject || '').replace(/[\r\n]+/g, ' ').trim();
    return await enqueue(toEmail, s, layout(String(innerHtml || ''), s), templateKey || null);
  } catch (e) {
    console.error(`[mailer] could not queue mail to ${toEmail}:`, e.message);
    return null;
  }
}

/** Send a template to the admin alert address, if one is set. */
function notifyAdmin(templateKey, vars = {}) {
  const to = settings.get('admin_notify_email');
  return isEmail(to) ? send(templateKey, to, vars) : Promise.resolve(null);
}

// ---------------------------------------------------------------------------------------------
// Delivery

/** Which provider will be used: Brevo HTTP API, SMTP, or none (mail is logged as skipped). */
function transportName() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'none';
}

function sender() {
  return {
    name: settings.get('mail_from_name') || settings.get('site_name') || 'Kasturi Auction',
    email: settings.get('mail_from_email') || settings.get('contact_email'),
  };
}

/** Rough plain-text version of an HTML email, for the SMTP text/plain part. */
function htmlToText(html) {
  return String(html)
    .replace(/<(head|style|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => `${label} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendBrevo(msg) {
  const from = sender();
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: from.name, email: from.email },
      to: [{ email: msg.to }],
      subject: msg.subject,
      htmlContent: msg.html,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch (e) { /* not JSON */ }
    throw new Error(`Brevo ${res.status}: ${String(detail).slice(0, 300)}`);
  }
}

let smtp = null;
function smtpTransport() {
  if (!smtp) {
    const port = Number(process.env.SMTP_PORT) || 587;
    smtp = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 587 and 25 upgrade with STARTTLS
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }
  return smtp;
}

async function sendSmtp(msg) {
  const from = sender();
  await smtpTransport().sendMail({
    from: { name: from.name, address: from.email },
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: htmlToText(msg.html),
  });
}

/**
 * Deliver up to 20 queued emails. Rows are locked with FOR UPDATE SKIP LOCKED for the length of
 * the batch, so several app instances can run this at once without sending anything twice.
 * Returns the number of rows handled.
 */
async function processQueue() {
  const transport = transportName();
  return db.tx(async (c) => {
    const rows = (await c.query(
      `SELECT id, to_email, subject, html, attempts FROM email_log
        WHERE status = 'queued' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [BATCH]
    )).rows;

    for (const m of rows) {
      if (transport === 'none') {
        await c.query(`UPDATE email_log SET status = 'skipped', error = 'No mail provider configured' WHERE id = $1`, [m.id]);
        if (process.env.NODE_ENV !== 'production') console.log(`[mailer] not sent (no provider): to=${m.to_email} subject="${m.subject}"`);
        continue;
      }
      try {
        const msg = { to: m.to_email, subject: m.subject, html: m.html };
        if (transport === 'brevo') await sendBrevo(msg); else await sendSmtp(msg);
        await c.query(`UPDATE email_log SET status = 'sent', sent_at = now(), attempts = attempts + 1, error = '' WHERE id = $1`, [m.id]);
      } catch (e) {
        const attempts = m.attempts + 1;
        await c.query(
          'UPDATE email_log SET attempts = $2, error = $3, status = $4 WHERE id = $1',
          [m.id, attempts, String(e.message || e).slice(0, 1000), attempts >= MAX_ATTEMPTS ? 'failed' : 'queued']
        );
        console.error(`[mailer] delivery to ${m.to_email} failed (attempt ${attempts}):`, e.message);
      }
    }
    return rows.length;
  });
}

// ---------------------------------------------------------------------------------------------
// Default templates (seeded once; admins edit them afterwards in the admin panel)

const DEFAULT_TEMPLATES = [
  {
    key: 'verify_email',
    name: 'Verify email address',
    description: 'Sent when a bidder registers, and when they ask for a new verification link.',
    variables: 'name, verify_url',
    subject: 'Verify your email address for {{site_name}}',
    body: `<p>Dear {{name}},</p>
<p>Thank you for registering with {{site_name}}. Please confirm that this email address belongs to you so that we can send you auction notices and bid updates.</p>
<p><a class="btn" href="{{verify_url}}">Verify email</a></p>
<p>If the button does not work, copy this link into your browser:<br>{{verify_url}}</p>
<p>If you did not create an account, you can ignore this email.</p>`,
  },
  {
    key: 'welcome',
    name: 'Welcome',
    description: 'Sent after a bidder verifies their email address.',
    variables: 'name, account_url',
    subject: 'Your {{site_name}} account is ready',
    body: `<p>Dear {{name}},</p>
<p>Your email address is verified. Before you can bid, please complete these steps from your account page:</p>
<ol>
<li>Fill in your business details and upload your GST certificate, PAN card and address proof.</li>
<li>Pay the registration fee, if your account page asks for it.</li>
<li>Wait for our team to check your documents. We will email you when they are approved.</li>
</ol>
<p><a class="btn" href="{{account_url}}">Go to my account</a></p>
<p>For help, write to {{contact_email}}.</p>`,
  },
  {
    key: 'password_reset',
    name: 'Password reset',
    description: 'Sent when a bidder asks to reset a forgotten password.',
    variables: 'name, reset_url',
    subject: 'Reset your {{site_name}} password',
    body: `<p>Dear {{name}},</p>
<p>We received a request to reset the password for your account. The link below can be used once and expires after a short time.</p>
<p><a class="btn" href="{{reset_url}}">Set a new password</a></p>
<p>If the button does not work, copy this link into your browser:<br>{{reset_url}}</p>
<p>If you did not ask for this, ignore this email. Your current password stays unchanged.</p>`,
  },
  {
    key: 'kyc_submitted_admin',
    name: 'Documents submitted (admin alert)',
    description: 'Sent to the admin alert address when a bidder submits business documents for review.',
    variables: 'bidder_name, company, bidder_no, admin_url',
    subject: 'Documents to review: {{company}} ({{bidder_no}})',
    body: `<p>A bidder has submitted business documents for approval.</p>
<table class="details">
<tr><td>Bidder</td><td>{{bidder_name}}</td></tr>
<tr><td>Company</td><td>{{company}}</td></tr>
<tr><td>Bidder number</td><td>{{bidder_no}}</td></tr>
</table>
<p>Check the documents against the details entered and approve or reject the application.</p>
<p><a class="btn" href="{{admin_url}}">Review documents</a></p>`,
  },
  {
    key: 'kyc_approved',
    name: 'Documents approved',
    description: 'Sent when an admin approves a bidder\'s business documents.',
    variables: 'name, account_url',
    subject: 'Your business documents are approved',
    body: `<p>Dear {{name}},</p>
<p>We have checked and approved your business documents.</p>
<p>Once any remaining steps on your account page are complete, such as the registration fee, you can bid in live auctions.</p>
<p><a class="btn" href="{{account_url}}">Go to my account</a></p>`,
  },
  {
    key: 'kyc_rejected',
    name: 'Documents not approved',
    description: 'Sent when an admin rejects a bidder\'s business documents, with the reason.',
    variables: 'name, reason, account_url',
    subject: 'Action needed on your business documents',
    body: `<p>Dear {{name}},</p>
<p>We could not approve the business documents you submitted, for this reason:</p>
<p>{{reason}}</p>
<p>Please correct the details or upload the right documents from your account page and submit them again.</p>
<p><a class="btn" href="{{account_url}}">Update my documents</a></p>
<p>If anything is unclear, write to {{contact_email}}.</p>`,
  },
  {
    key: 'fee_receipt',
    name: 'Registration fee receipt',
    description: 'Sent to the bidder when their registration fee payment is received, online or offline.',
    variables: 'name, company, base_amount, tax_amount, amount, payment_ref, paid_on, valid_until',
    subject: 'Payment received: registration fee {{amount}}',
    body: `<p>Dear {{name}},</p>
<p>We have received your registration fee. Please keep this email for your records.</p>
<table class="details">
<tr><td>Company</td><td>{{company}}</td></tr>
<tr><td>Fee</td><td>{{base_amount}}</td></tr>
<tr><td>GST</td><td>{{tax_amount}}</td></tr>
<tr><td>Total paid</td><td>{{amount}}</td></tr>
<tr><td>Payment reference</td><td>{{payment_ref}}</td></tr>
<tr><td>Paid on</td><td>{{paid_on}}</td></tr>
<tr><td>Valid until</td><td>{{valid_until}}</td></tr>
</table>
<p>If you need a GST invoice, write to {{contact_email}} with your GSTIN and billing address.</p>`,
  },
  {
    key: 'fee_paid_admin',
    name: 'Fee paid (admin alert)',
    description: 'Sent to the admin alert address when a bidder pays the registration fee.',
    variables: 'bidder_name, company, amount, payment_ref',
    subject: 'Registration fee received from {{company}}',
    body: `<p>A registration fee payment has been recorded.</p>
<table class="details">
<tr><td>Bidder</td><td>{{bidder_name}}</td></tr>
<tr><td>Company</td><td>{{company}}</td></tr>
<tr><td>Amount</td><td>{{amount}}</td></tr>
<tr><td>Reference</td><td>{{payment_ref}}</td></tr>
</table>`,
  },
  {
    key: 'auction_announcement',
    name: 'New auction',
    description: 'Sent to all verified bidders when an admin announces a published auction.',
    variables: 'name, auction_title, seller_name, location, starts_at, ends_at, lot_count, auction_url',
    subject: 'New auction: {{auction_title}}',
    body: `<p>Dear {{name}},</p>
<p>A new auction is open for viewing. Bidding starts at the time shown below.</p>
<table class="details">
<tr><td>Auction</td><td>{{auction_title}}</td></tr>
<tr><td>Seller</td><td>{{seller_name}}</td></tr>
<tr><td>Material location</td><td>{{location}}</td></tr>
<tr><td>Bidding starts</td><td>{{starts_at}}</td></tr>
<tr><td>Bidding ends</td><td>{{ends_at}}</td></tr>
<tr><td>Lots</td><td>{{lot_count}}</td></tr>
</table>
<p>Read the lot details, inspection arrangements and terms before you bid.</p>
<p><a class="btn" href="{{auction_url}}">View auction</a></p>`,
  },
  {
    key: 'auction_reminder',
    name: 'Auction starting soon',
    description: 'Sent to all verified bidders shortly before an auction starts (lead time set in Settings).',
    variables: 'name, auction_title, seller_name, location, starts_at, ends_at, lot_count, auction_url',
    subject: 'Starting soon: {{auction_title}}',
    body: `<p>Dear {{name}},</p>
<p>Bidding on {{auction_title}} starts at {{starts_at}} and is scheduled to end at {{ends_at}}. Lots may close later if bids come in during the last few minutes.</p>
<table class="details">
<tr><td>Seller</td><td>{{seller_name}}</td></tr>
<tr><td>Material location</td><td>{{location}}</td></tr>
<tr><td>Lots</td><td>{{lot_count}}</td></tr>
</table>
<p>Sign in a few minutes early and check that your account is ready to bid.</p>
<p><a class="btn" href="{{auction_url}}">Open auction</a></p>`,
  },
  {
    key: 'outbid',
    name: 'Outbid',
    description: 'Sent when another bidder places a higher bid on a lot where this bidder was leading (at most once every 10 minutes per lot).',
    variables: 'name, auction_title, lot_no, lot_title, your_bid, auction_url',
    subject: 'You have been outbid on lot {{lot_no}}',
    body: `<p>Dear {{name}},</p>
<p>Another bidder has placed a higher bid on lot {{lot_no}}, {{lot_title}}, in {{auction_title}}. Your last bid was {{your_bid}}.</p>
<p>If the lot is still open, you can place a new bid.</p>
<p><a class="btn" href="{{auction_url}}">Bid again</a></p>`,
  },
  {
    key: 'lot_won',
    name: 'Lot awarded',
    description: 'Sent to the highest bidder when a lot is awarded to them.',
    variables: 'name, auction_title, lot_no, lot_title, quantity, winning_bid, account_url',
    subject: 'Lot {{lot_no}} awarded to you: {{lot_title}}',
    body: `<p>Dear {{name}},</p>
<p>Your bid has been accepted and the lot below is awarded to you.</p>
<table class="details">
<tr><td>Auction</td><td>{{auction_title}}</td></tr>
<tr><td>Lot</td><td>{{lot_no}}, {{lot_title}}</td></tr>
<tr><td>Quantity</td><td>{{quantity}}</td></tr>
<tr><td>Winning bid</td><td>{{winning_bid}}</td></tr>
</table>
<p>The seller or our team will contact you with the payment and lifting schedule. Payment, taxes and lifting follow the terms of this auction. Please keep your GST and transport documents ready.</p>
<p><a class="btn" href="{{account_url}}">View my bids</a></p>`,
  },
  {
    key: 'enquiry_ack',
    name: 'Enquiry received',
    description: 'Sent to a visitor after they submit the contact form.',
    variables: 'name, message',
    subject: 'We have received your enquiry',
    body: `<p>Dear {{name}},</p>
<p>Thank you for contacting {{site_name}}. We will reply within one working day. Your message was:</p>
<p>{{message}}</p>
<p>If your matter is urgent, write to {{contact_email}} and mention your company name.</p>`,
  },
  {
    key: 'enquiry_admin',
    name: 'New enquiry (admin alert)',
    description: 'Sent to the admin alert address when a visitor submits the contact form.',
    variables: 'name, email, phone, company, message',
    subject: 'New enquiry from {{name}}',
    body: `<p>A new enquiry has come in through the website.</p>
<table class="details">
<tr><td>Name</td><td>{{name}}</td></tr>
<tr><td>Email</td><td>{{email}}</td></tr>
<tr><td>Phone</td><td>{{phone}}</td></tr>
<tr><td>Company</td><td>{{company}}</td></tr>
</table>
<p>{{message}}</p>`,
  },
];

module.exports = {
  send, sendRaw, notifyAdmin, render, renderString, url, processQueue, transportName, DEFAULT_TEMPLATES,
  htmlToText, // exported for tests and previews
};
