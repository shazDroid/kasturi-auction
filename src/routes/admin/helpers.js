// Small shared helpers for the admin routes and views.
const { escapeHtml, toInt, fmtDate, TZ } = require('../../lib/util');

const fSec = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
/** "22 Nov 2026, 3:04:27 pm": bid times need seconds. */
const fmtDTs = (d) => (d ? `${fmtDate(d)}, ${fSec.format(new Date(d)).toLowerCase()}` : '');
const fmtTimeS = (d) => (d ? fSec.format(new Date(d)).toLowerCase() : '');
/** Bytes as "240 KB". */
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const TAGS = {
  phase: {
    draft: ['tag', 'Draft'], cancelled: ['tag tag-bad', 'Cancelled'], upcoming: ['tag tag-upcoming', 'Upcoming'],
    live: ['tag tag-live', 'Live'], closed: ['tag', 'Closed'],
  },
  status: { draft: ['tag', 'Draft'], published: ['tag tag-ok', 'Published'], cancelled: ['tag tag-bad', 'Cancelled'] },
  kyc: {
    incomplete: ['tag', 'Not submitted'], pending: ['tag tag-warn', 'Awaiting review'],
    approved: ['tag tag-ok', 'Approved'], rejected: ['tag tag-bad', 'Rejected'],
  },
  result: {
    open: ['tag tag-live', 'Open'], pending: ['tag tag-warn', 'Awaiting decision'], awarded: ['tag tag-ok', 'Awarded'],
    rejected: ['tag tag-bad', 'Rejected'], no_bids: ['tag', 'No bids'], closed: ['tag', 'Closed'],
  },
  payment: { created: ['tag', 'Not completed'], paid: ['tag tag-ok', 'Paid'], failed: ['tag tag-bad', 'Failed'], refunded: ['tag tag-warn', 'Refunded'] },
  email: { queued: ['tag tag-upcoming', 'Queued'], sent: ['tag tag-ok', 'Sent'], failed: ['tag tag-bad', 'Failed'], skipped: ['tag', 'Skipped'] },
  yesno: { true: ['tag tag-ok', 'Yes'], false: ['tag', 'No'] },
  role: { superadmin: ['tag tag-upcoming', 'Super admin'], staff: ['tag', 'Staff'] },
};

/** HTML for a status tag. Only fixed class names and escaped text, so safe for <%- %>. */
function tag(kind, value, text) {
  const map = TAGS[kind] || {};
  const t = map[String(value)] || ['tag', String(value ?? '')];
  return `<span class="${t[0]}">${escapeHtml(text || t[1])}</span>`;
}

const LABELS = {
  phase: { draft: 'Draft', cancelled: 'Cancelled', upcoming: 'Upcoming', live: 'Live', closed: 'Closed' },
  result: { pending: 'Awaiting decision', awarded: 'Awarded', rejected: 'Rejected', no_bids: 'No bids' },
  kyc: { incomplete: 'Not submitted', pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected' },
};
const label = (kind, value) => (LABELS[kind] && LABELS[kind][value]) || value || '';

/** Pagination numbers. */
function paginate(total, pageParam, per) {
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, toInt(pageParam, 1)), pages);
  return { page, pages, per, total, offset: (page - 1) * per };
}

/** Current URL with some query params replaced (empty values dropped). */
function urlWith(req, overrides) {
  const params = new URLSearchParams();
  const merged = { ...req.query, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '' || k === '_csrf') continue;
    params.set(k, String(v));
  }
  const base = req.baseUrl + req.path;
  const s = params.toString();
  return s ? `${base}?${s}` : base;
}

function viewHelpers(req) {
  return {
    tag,
    label,
    fmtDTs,
    fmtTimeS,
    fmtSize,
    urlWith: (o) => urlWith(req, o),
  };
}

/** Plain 404 inside the admin layout. */
const notFound = (res, what = 'This record') => {
  res.status(404);
  return res.adminPage('admin/not_found', { title: 'Not found', what });
};

/** Allow this page to frame same-origin previews (the site CSP only allows Razorpay frames). */
function allowSelfFrames(res) {
  const csp = res.get('Content-Security-Policy');
  if (csp) res.set('Content-Security-Policy', csp.replace(/frame-src ([^;]*)/, "frame-src 'self' $1"));
}

/** Response CSP for rendering email HTML inside a sandboxed iframe: inline styles, no scripts. */
function emailPreviewHeaders(res) {
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; frame-ancestors 'self'");
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
}

/** Redirect back to a same-site admin URL given in the form, or to a fallback. */
function back(req, fallback) {
  const to = String((req.body && req.body.back) || '');
  return to.startsWith('/admin') && !to.startsWith('//') ? to : fallback;
}

const sendCsv = (res, filename, rows) => {
  const { toCsv } = require('../../lib/util');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.send('﻿' + toCsv(rows));
};

module.exports = { tag, label, paginate, urlWith, viewHelpers, notFound, allowSelfFrames, emailPreviewHeaders, back, sendCsv };
