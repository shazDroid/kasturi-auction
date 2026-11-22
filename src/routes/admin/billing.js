// Billing: sale orders for awarded lots, settlement tracking, tax invoices, invoice payments and bidder statements.
const express = require('express');
const db = require('../../db');
const settings = require('../../lib/settings');
const billing = require('../../lib/billing');
const xl = require('../../lib/excel');
const { clean, toInt, bidderNo, fmtINR } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { paginate, notFound, back, sendCsv } = require('./helpers');

const router = express.Router();
const STYLES = ['/css/admin-extra.css', '/css/admin-billing.css'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00+05:30'));
const today = () => billing.istDate(new Date());
const r2 = billing.round2;

/** Run a billing action, turning BillingError into a flash message. */
async function attempt(req, fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof billing.BillingError) { req.flash('error', e.message); return undefined; }
    throw e;
  }
}

function sendPdf(res, buf, name, inline = true) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.-]+/g, '_')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}

router.get('/billing', (req, res) => res.redirect('/admin/billing/sale-orders'));

// ---------------------------------------------------------------------------------------------
// Sale orders

const AWARDED_FROM = `FROM lots l JOIN auctions a ON a.id = l.auction_id
  JOIN bids w ON w.id = l.winning_bid_id JOIN users u ON u.id = w.user_id
  LEFT JOIN bidder_groups g ON g.id = u.group_id`;

router.get('/billing/sale-orders', wrap(async (req, res) => {
  const tab = req.query.tab === 'issued' ? 'issued' : 'pending';
  const auctionId = toInt(req.query.auction, 0) || null;
  const q = clean(req.query.q, 100);
  const def = settings.num('default_commission_percent');
  const search = `($3 = '' OR u.name ILIKE '%' || $3 || '%' OR u.company_name ILIKE '%' || $3 || '%' OR l.title ILIKE '%' || $3 || '%' OR a.title ILIKE '%' || $3 || '%')`;
  const counts = await db.one(
    `SELECT count(*) FILTER (WHERE s.id IS NULL)::int AS pending, count(s.id)::int AS issued
       ${AWARDED_FROM} LEFT JOIN sale_orders s ON s.lot_id = l.id
      WHERE l.result = 'awarded' AND ($1::int IS NULL OR a.id = $1)`, [auctionId]
  );
  // Issued sale orders also stay listed if the lot was later rejected.
  const issuedCount = (await db.one(`SELECT count(*)::int AS n FROM sale_orders s JOIN lots l ON l.id = s.lot_id WHERE ($1::int IS NULL OR l.auction_id = $1)`, [auctionId])).n;
  counts.issued = issuedCount;
  let rows;
  let pg;
  if (tab === 'pending') {
    const where = `WHERE l.result = 'awarded' AND NOT EXISTS (SELECT 1 FROM sale_orders s WHERE s.lot_id = l.id) AND ($1::int IS NULL OR a.id = $1) AND ${search.replace(/\$3/g, '$2')}`;
    const { n } = await db.one(`SELECT count(*)::int AS n ${AWARDED_FROM} ${where}`, [auctionId, q]);
    pg = paginate(n, req.query.page, 50);
    rows = await db.many(
      `SELECT l.id, l.lot_no, l.title, l.quantity, l.unit, l.ends_at, a.id AS auction_id, a.title AS auction_title,
              w.amount AS rate, u.id AS user_id, u.name, u.company_name, ${billing.commissionPctSql(3)} AS pct
         ${AWARDED_FROM} ${where} ORDER BY l.ends_at DESC, a.id, l.lot_no LIMIT $4 OFFSET $5`,
      [auctionId, q, def, pg.per, pg.offset]
    );
    for (const r of rows) { r.value = r2(r.rate * r.quantity); r.commission = r2(r.value * r.pct / 100); }
  } else {
    const where = `WHERE ($1::int IS NULL OR l.auction_id = $1) AND ($2 = '' OR s.number ILIKE '%' || $2 || '%' OR u.name ILIKE '%' || $2 || '%'
      OR u.company_name ILIKE '%' || $2 || '%' OR s.snapshot->'lot'->>'title' ILIKE '%' || $2 || '%' OR s.snapshot->'auction'->>'title' ILIKE '%' || $2 || '%')`;
    const { n } = await db.one(`SELECT count(*)::int AS n FROM sale_orders s JOIN lots l ON l.id = s.lot_id JOIN users u ON u.id = s.user_id ${where}`, [auctionId, q]);
    pg = paginate(n, req.query.page, 50);
    rows = await db.many(
      `SELECT s.id, s.number, s.issued_at, s.snapshot, s.user_id, u.name, u.company_name, l.buyer_paid_at, l.lifted_at, l.result,
              (SELECT i.number FROM invoices i WHERE i.lot_id = s.lot_id AND i.kind = 'commission' AND i.status <> 'cancelled' ORDER BY i.id LIMIT 1) AS inv_number
         FROM sale_orders s JOIN lots l ON l.id = s.lot_id JOIN users u ON u.id = s.user_id ${where}
        ORDER BY s.issued_at DESC, s.id DESC LIMIT $3 OFFSET $4`, [auctionId, q, pg.per, pg.offset]
    );
  }
  const auctions = await db.many(
    `SELECT DISTINCT a.id, a.title, a.ends_at FROM auctions a JOIN lots l ON l.auction_id = a.id WHERE l.result = 'awarded' OR EXISTS (SELECT 1 FROM sale_orders s WHERE s.lot_id = l.id) ORDER BY a.ends_at DESC LIMIT 300`
  );
  res.adminPage('admin/billing_sale_orders', { title: 'Sale orders', styles: STYLES, tab, rows, pg, counts, auctionId, auctions, q });
}));

router.post('/billing/sale-orders/issue', wrap(async (req, res) => {
  const lotId = toInt(req.body.lot_id, 0);
  const to = back(req, '/admin/billing/sale-orders');
  const before = await db.one('SELECT id FROM sale_orders WHERE lot_id = $1', [lotId]);
  const so = await attempt(req, () => billing.issueSaleOrder(lotId, req.admin.id));
  if (so) {
    if (before) req.flash('info', `Sale order ${so.number} was already issued for this lot.`);
    else {
      audit(req, 'sale_order.issue', `${so.number} for lot #${lotId}`);
      req.flash('ok', `Sale order ${so.number} issued and emailed to the buyer.`);
    }
    if (req.body.open === '1') return res.redirect(`/admin/billing/sale-orders/${so.id}`);
  }
  res.redirect(to);
}));

router.post('/billing/sale-orders/issue-auction', wrap(async (req, res) => {
  const auctionId = toInt(req.body.auction_id, 0);
  const to = back(req, '/admin/billing/sale-orders');
  const lots = await db.many(
    `SELECT l.id FROM lots l WHERE l.auction_id = $1 AND l.result = 'awarded' AND l.winning_bid_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sale_orders s WHERE s.lot_id = l.id) ORDER BY l.lot_no`, [auctionId]
  );
  if (!lots.length) { req.flash('info', 'Every awarded lot in this auction already has a sale order.'); return res.redirect(to); }
  const issued = [];
  const failed = [];
  for (const l of lots) {
    try { issued.push((await billing.issueSaleOrder(l.id, req.admin.id)).number); } catch (e) {
      if (!(e instanceof billing.BillingError)) throw e;
      failed.push(e.message);
    }
  }
  if (issued.length) {
    audit(req, 'sale_order.issue_auction', `auction #${auctionId}: ${issued.join(', ')}`);
    req.flash('ok', `${issued.length} sale order${issued.length === 1 ? '' : 's'} issued (${issued[0]}${issued.length > 1 ? ' to ' + issued[issued.length - 1] : ''}) and emailed to the buyers.`);
  }
  for (const f of failed.slice(0, 3)) req.flash('error', f);
  res.redirect(to);
}));

router.get('/billing/sale-orders/:id(\\d+).pdf', wrap(async (req, res) => {
  const so = await db.one('SELECT id, number FROM sale_orders WHERE id = $1', [req.params.id]);
  if (!so) return notFound(res, 'This sale order');
  sendPdf(res, await billing.saleOrderPdf(so.id), `sale-order-${so.number}.pdf`, req.query.download !== '1');
}));

router.get('/billing/sale-orders/:id(\\d+)', wrap(async (req, res) => {
  const so = await db.one(
    `SELECT s.*, u.name, u.company_name, u.email, ad.name AS issued_by_name,
            l.result, l.buyer_paid_at, l.lifted_at, l.settlement_note, l.commission_percent AS lot_pct
       FROM sale_orders s JOIN users u ON u.id = s.user_id JOIN lots l ON l.id = s.lot_id
       LEFT JOIN admins ad ON ad.id = s.issued_by WHERE s.id = $1`, [req.params.id]
  );
  if (!so) return notFound(res, 'This sale order');
  const invoices = await db.many(
    `SELECT i.id, i.number, i.issued_at, i.total, i.status, i.due_at,
            (SELECT COALESCE(sum(amount), 0) FROM invoice_payments ip WHERE ip.invoice_id = i.id) AS paid
       FROM invoices i WHERE i.lot_id = $1 AND i.kind = 'commission' ORDER BY i.id`, [so.lot_id]
  );
  const activeInvoice = invoices.find((i) => i.status !== 'cancelled') || null;
  let commissionNow = null;
  if (!activeInvoice && so.result === 'awarded') commissionNow = await billing.commissionQuote(so.lot_id).catch(() => null);
  res.adminPage('admin/billing_sale_order', {
    title: `Sale order ${so.number}`, styles: STYLES, so, s: so.snapshot, invoices, activeInvoice, commissionNow, today: today(),
  });
}));

router.post('/billing/sale-orders/:id(\\d+)/email', wrap(async (req, res) => {
  const so = await db.one('SELECT s.id, s.number, u.email FROM sale_orders s JOIN users u ON u.id = s.user_id WHERE s.id = $1', [req.params.id]);
  if (!so) return notFound(res, 'This sale order');
  const r = await billing.emailSaleOrder(so.id);
  audit(req, 'sale_order.email', `${so.number} to ${so.email}`);
  req.flash(r ? 'ok' : 'error', r ? `Sale order ${so.number} emailed again to ${so.email}.` : `The email could not be queued. Check that the "sale_order_issued" template exists and is switched on under Email templates.`);
  res.redirect(back(req, `/admin/billing/sale-orders/${so.id}`));
}));

router.post('/billing/lots/:id(\\d+)/commission-invoice', wrap(async (req, res) => {
  const lot = await db.one('SELECT id, lot_no FROM lots WHERE id = $1', [req.params.id]);
  if (!lot) return notFound(res, 'This lot');
  const to = back(req, '/admin/billing/sale-orders');
  const before = await db.one(`SELECT id FROM invoices WHERE lot_id = $1 AND kind = 'commission' AND status <> 'cancelled'`, [lot.id]);
  const inv = await attempt(req, () => billing.issueCommissionInvoice(lot.id, req.admin.id));
  if (inv === null) req.flash('info', `No commission is payable on lot ${lot.lot_no}, so no invoice was raised.`);
  else if (inv && before) req.flash('info', `Commission invoice ${inv.number} already exists for lot ${lot.lot_no}.`);
  else if (inv) {
    audit(req, 'invoice.issue_commission', `${inv.number} for lot #${lot.id}, ${inv.total}`);
    req.flash('ok', `Commission invoice ${inv.number} for ${fmtINR(inv.total)} issued and emailed to the buyer.`);
  }
  res.redirect(to);
}));

const SETTLE = {
  buyer_paid: ['buyer_paid_at', 'Buyer payment to the seller marked as received'],
  lifted: ['lifted_at', 'Material marked as lifted'],
  undo_buyer_paid: ['buyer_paid_at', 'Buyer payment mark removed'],
  undo_lifted: ['lifted_at', 'Lifted mark removed'],
};
router.post('/billing/lots/:id(\\d+)/settlement', wrap(async (req, res) => {
  const lot = await db.one('SELECT id, lot_no, settlement_note, buyer_paid_at, lifted_at FROM lots WHERE id = $1', [req.params.id]);
  if (!lot) return notFound(res, 'This lot');
  const to = back(req, '/admin/billing/sale-orders');
  const act = SETTLE[req.body.action] ? req.body.action : null;
  if (!act) { req.flash('error', 'Choose what to record.'); return res.redirect(to); }
  const [col, text] = SETTLE[act];
  const undo = act.startsWith('undo_');
  const day = clean(req.body.date, 10) || today();
  if (!undo && (!isDate(day) || day > today())) { req.flash('error', 'Enter a valid date that is not in the future.'); return res.redirect(to); }
  const note = clean(req.body.note, 300);
  const line = `${text}${undo ? '' : ' on ' + day}${note ? ': ' + note : ''} (${req.admin.name})`;
  const newNote = [lot.settlement_note, line].filter(Boolean).join('\n').slice(-2000);
  // The column name comes from the fixed SETTLE map above, never from the request.
  await db.query(`UPDATE lots SET ${col} = $2, settlement_note = $3 WHERE id = $1`,
    [lot.id, undo ? null : day + 'T12:00:00+05:30', newNote]);
  audit(req, `lot.settlement.${act}`, `lot #${lot.id}${undo ? '' : ' ' + day}${note ? ': ' + note : ''}`);
  req.flash('ok', `Lot ${lot.lot_no}: ${text.toLowerCase()}.`);
  res.redirect(to);
}));

// ---------------------------------------------------------------------------------------------
// Invoices

const INV_STATUSES = { unpaid: 'Unpaid', part_paid: 'Part paid', paid: 'Paid', cancelled: 'Cancelled', overdue: 'Overdue' };

function invoiceFilter(query) {
  const f = {
    status: INV_STATUSES[query.status] ? query.status : '',
    kind: billing.KINDS[query.kind] ? query.kind : '',
    from: isDate(query.from) ? query.from : '',
    to: isDate(query.to) ? query.to : '',
    q: clean(query.q, 100),
    user: toInt(query.user, 0) || 0,
  };
  const where = `WHERE ($1 = '' OR ($1 = 'overdue' AND i.status IN ('unpaid','part_paid') AND i.due_at < now()) OR ($1 <> 'overdue' AND i.status = $1))
    AND ($2 = '' OR i.kind = $2)
    AND ($3 = '' OR i.issued_at >= ($3 || 'T00:00:00+05:30')::timestamptz)
    AND ($4 = '' OR i.issued_at < ($4 || 'T00:00:00+05:30')::timestamptz + interval '1 day')
    AND ($5 = '' OR i.number ILIKE '%' || $5 || '%' OR u.name ILIKE '%' || $5 || '%' OR u.company_name ILIKE '%' || $5 || '%' OR u.email ILIKE '%' || $5 || '%')
    AND ($6 = 0 OR i.user_id = $6)`;
  return { f, where, params: [f.status, f.kind, f.from, f.to, f.q, f.user] };
}
const INV_FROM = `FROM invoices i JOIN users u ON u.id = i.user_id
  LEFT JOIN LATERAL (SELECT COALESCE(sum(amount), 0) AS paid FROM invoice_payments ip WHERE ip.invoice_id = i.id) pp ON true`;

router.get('/billing/invoices', wrap(async (req, res) => {
  const { f, where, params } = invoiceFilter(req.query);
  const totals = await db.one(
    `SELECT count(*)::int AS n,
            COALESCE(sum(i.total) FILTER (WHERE i.status <> 'cancelled'), 0) AS total,
            COALESCE(sum(pp.paid) FILTER (WHERE i.status <> 'cancelled'), 0) AS paid,
            COALESCE(sum(i.total - pp.paid) FILTER (WHERE i.status <> 'cancelled'), 0) AS balance
       ${INV_FROM} ${where}`, params
  );
  const pg = paginate(totals.n, req.query.page, 50);
  const rows = await db.many(
    `SELECT i.id, i.number, i.kind, i.issued_at, i.due_at, i.total, i.status, i.user_id, i.snapshot, u.name, u.company_name, pp.paid,
            (i.status IN ('unpaid','part_paid') AND i.due_at < now()) AS overdue
       ${INV_FROM} ${where} ORDER BY i.issued_at DESC, i.id DESC LIMIT $7 OFFSET $8`, [...params, pg.per, pg.offset]
  );
  for (const r of rows) r.description = billing.invoiceDescription(r);
  const missing = await billing.missingFeeInvoices();
  res.adminPage('admin/billing_invoices', {
    title: 'Invoices', styles: STYLES, rows, totals, pg, f, INV_STATUSES, KINDS: billing.KINDS, missing,
  });
}));

router.get('/billing/invoices.csv', wrap(async (req, res) => {
  const { where, params } = invoiceFilter(req.query);
  const rows = await db.many(`SELECT i.*, u.name, u.company_name, u.gstin, pp.paid ${INV_FROM} ${where} ORDER BY i.issued_at, i.id`, params);
  const out = [['Invoice no', 'Date', 'Bidder no', 'Bidder', 'Company', 'GSTIN', 'Kind', 'Description', 'Taxable (INR)', 'CGST', 'SGST', 'IGST', 'Total (INR)', 'Paid (INR)', 'Balance (INR)', 'Status', 'Due date']];
  for (const r of rows) {
    const t = billing.taxHeads(r.snapshot);
    out.push([r.number, billing.istDate(r.issued_at), bidderNo(r.user_id), r.name, r.company_name, r.gstin, billing.KINDS[r.kind] || r.kind,
      billing.invoiceDescription(r), r.subtotal, t.cgst, t.sgst, t.igst, r.total, r.paid, r.status === 'cancelled' ? 0 : r2(r.total - r.paid),
      billing.STATUSES[r.status] || r.status, r.due_at ? billing.istDate(r.due_at) : '']);
  }
  audit(req, 'invoice.export', `${rows.length} rows`);
  sendCsv(res, `invoices-${today()}.csv`, out);
}));

router.post('/billing/invoices/backfill', wrap(async (req, res) => {
  const n = await billing.backfillFeeInvoices();
  audit(req, 'invoice.backfill_fees', `${n} invoices`);
  req.flash(n ? 'ok' : 'info', n ? `${n} invoice${n === 1 ? '' : 's'} raised for earlier fee payments.` : 'Every paid fee already has an invoice.');
  res.redirect('/admin/billing/invoices');
}));

async function bidderMatches(q) {
  if (!q) return [];
  return db.many(
    `SELECT id, name, company_name, email, state FROM users
      WHERE name ILIKE '%' || $1 || '%' OR company_name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%' OR gstin ILIKE '%' || $1 || '%'
         OR ('KA-' || lpad(id::text, 5, '0')) ILIKE '%' || $1 || '%'
      ORDER BY company_name, name LIMIT 30`, [q]
  );
}

const blankForm = () => ({ user_id: '', gst: String(settings.num('commission_gst_percent')), due_days: String(settings.num('invoice_due_days')), note: '', lines: Array.from({ length: 10 }, () => ({ description: '', qty: '', rate: '' })) });

router.get('/billing/invoices/new', wrap(async (req, res) => {
  const q = clean(req.query.q, 100);
  const form = blankForm();
  const preset = toInt(req.query.user, 0);
  let matches = await bidderMatches(q);
  if (preset) {
    const u = await db.one('SELECT id, name, company_name, email, state FROM users WHERE id = $1', [preset]);
    if (u) { form.user_id = String(u.id); if (!matches.find((m) => m.id === u.id)) matches = [u, ...matches]; }
  }
  res.adminPage('admin/billing_invoice_new', { title: 'New invoice', styles: STYLES, q, matches, form, error: '' });
}));

router.post('/billing/invoices/new', wrap(async (req, res) => {
  const b = req.body;
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push({ description: clean(b[`desc_${i}`], 300), qty: clean(b[`qty_${i}`], 20).replace(/,/g, ''), rate: clean(b[`rate_${i}`], 20).replace(/[,₹\s]/g, '') });
  const form = { user_id: clean(b.user_id, 12), gst: clean(b.gst, 6), due_days: clean(b.due_days, 4), note: clean(b.note, 1000), lines };
  const userId = toInt(form.user_id, 0);
  const inv = await (async () => {
    try {
      return await billing.createManualInvoice({ userId, lines, gstPercent: form.gst === '' ? 0 : Number(form.gst), dueDays: form.due_days === '' ? '' : Number(form.due_days), note: form.note }, req.admin.id);
    } catch (e) {
      if (!(e instanceof billing.BillingError)) throw e;
      const u = userId ? await db.one('SELECT id, name, company_name, email, state FROM users WHERE id = $1', [userId]) : null;
      res.status(422);
      res.adminPage('admin/billing_invoice_new', { title: 'New invoice', styles: STYLES, q: '', matches: u ? [u] : [], form, error: e.message });
      return null;
    }
  })();
  if (!inv) return;
  audit(req, 'invoice.create', `${inv.number} for user #${userId}, ${inv.total}`);
  req.flash('ok', `Invoice ${inv.number} for ${fmtINR(inv.total)} issued and emailed to the bidder.`);
  res.redirect(`/admin/billing/invoices/${inv.id}`);
}));

router.get('/billing/invoices/:id(\\d+).pdf', wrap(async (req, res) => {
  const inv = await db.one('SELECT id, number FROM invoices WHERE id = $1', [req.params.id]);
  if (!inv) return notFound(res, 'This invoice');
  sendPdf(res, await billing.invoicePdf(inv.id), `invoice-${inv.number}.pdf`, req.query.download !== '1');
}));

router.get('/billing/invoices/:id(\\d+)', wrap(async (req, res) => {
  const inv = await billing.getInvoice(req.params.id);
  if (!inv) return notFound(res, 'This invoice');
  const u = await db.one('SELECT id, name, company_name, email FROM users WHERE id = $1', [inv.user_id]);
  const so = inv.lot_id ? await db.one('SELECT id, number FROM sale_orders WHERE lot_id = $1', [inv.lot_id]) : null;
  const issuer = inv.issued_by ? await db.one('SELECT name FROM admins WHERE id = $1', [inv.issued_by]) : null;
  res.adminPage('admin/billing_invoice', {
    title: `Invoice ${inv.number}`, styles: STYLES, inv, s: inv.snapshot, u, so, issuer, today: today(),
    PAY_METHODS: billing.PAY_METHODS, KINDS: billing.KINDS, STATUSES: billing.STATUSES,
    overdue: inv.due_at && ['unpaid', 'part_paid'].includes(inv.status) && new Date(inv.due_at) < new Date(),
  });
}));

router.post('/billing/invoices/:id(\\d+)/payments', wrap(async (req, res) => {
  const id = toInt(req.params.id, 0);
  const amount = Number(String(req.body.amount || '').replace(/[,₹\s]/g, ''));
  const row = await attempt(req, () => billing.recordPayment(id, {
    amount, method: clean(req.body.method, 20), reference: clean(req.body.reference, 200), paidOn: clean(req.body.paid_on, 10), note: clean(req.body.note, 500),
  }, req.admin.id));
  if (row) {
    audit(req, 'invoice.payment', `${row.number}: ${row.amount} by ${row.method}${row.reference ? ' ref ' + row.reference : ''}`);
    req.flash('ok', `Payment of ${fmtINR(row.amount)} recorded against ${row.number}. Status: ${billing.STATUSES[row.status].toLowerCase()}.`);
  }
  res.redirect(`/admin/billing/invoices/${id}`);
}));

router.post('/billing/invoice-payments/:id(\\d+)/remove', wrap(async (req, res) => {
  const p = await attempt(req, () => billing.removePayment(toInt(req.params.id, 0)));
  if (p) {
    audit(req, 'invoice.payment_remove', `${p.number}: removed payment #${p.id} of ${p.amount}`);
    req.flash('ok', `Payment of ${fmtINR(p.amount)} removed from ${p.number}.`);
    return res.redirect(`/admin/billing/invoices/${p.invoice_id}`);
  }
  res.redirect(back(req, '/admin/billing/invoices'));
}));

router.post('/billing/invoices/:id(\\d+)/cancel', wrap(async (req, res) => {
  const id = toInt(req.params.id, 0);
  const inv = await attempt(req, () => billing.cancelInvoice(id, clean(req.body.note, 500)));
  if (inv) {
    audit(req, 'invoice.cancel', `${inv.number}: ${inv.cancel_note}`);
    req.flash('ok', `Invoice ${inv.number} cancelled. Its number stays used.`);
  }
  res.redirect(`/admin/billing/invoices/${id}`);
}));

router.post('/billing/invoices/:id(\\d+)/email', wrap(async (req, res) => {
  const inv = await db.one('SELECT i.id, i.number, i.status, u.email FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.id = $1', [req.params.id]);
  if (!inv) return notFound(res, 'This invoice');
  if (inv.status === 'cancelled') { req.flash('error', 'A cancelled invoice cannot be emailed.'); return res.redirect(`/admin/billing/invoices/${inv.id}`); }
  const r = await billing.emailInvoice(inv.id);
  audit(req, 'invoice.email', `${inv.number} to ${inv.email}`);
  req.flash(r ? 'ok' : 'error', r ? `Invoice ${inv.number} emailed to ${inv.email}.` : 'The email could not be queued. Check that the "invoice_issued" template exists and is switched on under Email templates.');
  res.redirect(`/admin/billing/invoices/${inv.id}`);
}));

// ---------------------------------------------------------------------------------------------
// Bidder statement

async function statement(userId, query) {
  const user = await db.one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return null;
  const from = isDate(query.from) ? query.from : '';
  const to = isDate(query.to) ? query.to : today();
  // Debits: invoices on their issue day (cancelled ones excluded). Credits: payments on the day received.
  const entries = await db.many(
    `SELECT e.*, e.day::text AS day_s FROM (
       SELECT (i.issued_at AT TIME ZONE 'Asia/Kolkata')::date AS day, i.issued_at AS ts, 'invoice' AS type, i.id AS ref_id, i.number, i.kind, i.snapshot, i.total AS debit, 0::numeric AS credit, i.id AS inv_id
         FROM invoices i WHERE i.user_id = $1 AND i.status <> 'cancelled'
       UNION ALL
       SELECT ip.paid_on AS day, ip.created_at AS ts, 'payment' AS type, ip.id AS ref_id, i.number, i.kind, NULL AS snapshot, 0::numeric AS debit, ip.amount AS credit, i.id AS inv_id
         FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.user_id = $1 AND i.status <> 'cancelled'
     ) e WHERE e.day <= $2::date ORDER BY e.day, e.type DESC, e.ts, e.ref_id`, [userId, to]
  );
  let opening = 0;
  let bal = 0;
  const rows = [];
  for (const e of entries) {
    const day = e.day_s;
    bal = r2(bal + e.debit - e.credit);
    if (from && day < from) { opening = bal; continue; }
    rows.push({
      date: day + 'T12:00:00+05:30', day, type: e.type, number: e.number, inv_id: e.inv_id,
      description: e.type === 'invoice' ? billing.invoiceDescription({ kind: e.kind, snapshot: e.snapshot }) : `Payment received against ${e.number}`,
      debit: e.debit, credit: e.credit, balance: bal,
    });
  }
  const totals = { debit: r2(rows.reduce((s, r) => s + r.debit, 0)), credit: r2(rows.reduce((s, r) => s + r.credit, 0)) };
  return { user, from, to, opening, rows, closing: bal, totals };
}

router.get('/billing/statement/:userId(\\d+)', wrap(async (req, res) => {
  const st = await statement(toInt(req.params.userId, 0), req.query);
  if (!st) return notFound(res, 'This bidder');
  const saleOrders = await db.many('SELECT id, number, issued_at, snapshot FROM sale_orders WHERE user_id = $1 ORDER BY issued_at DESC', [st.user.id]);
  res.adminPage('admin/billing_statement', { title: `Statement: ${st.user.company_name || st.user.name}`, styles: STYLES, st, saleOrders });
}));

router.get('/billing/statement/:userId(\\d+).pdf', wrap(async (req, res) => {
  const st = await statement(toInt(req.params.userId, 0), req.query);
  if (!st) return notFound(res, 'This bidder');
  audit(req, 'statement.pdf', bidderNo(st.user.id));
  sendPdf(res, await billing.statementPdf(st), `statement-${bidderNo(st.user.id)}-${st.to}.pdf`);
}));

router.get('/billing/statement/:userId(\\d+).xlsx', wrap(async (req, res) => {
  const st = await statement(toInt(req.params.userId, 0), req.query);
  if (!st) return notFound(res, 'This bidder');
  const wb = xl.workbook();
  xl.addTable(wb, 'Statement', {
    title: `Statement of account: ${st.user.company_name || st.user.name} (${bidderNo(st.user.id)})`,
    filters: [`From ${st.from || 'the first entry'} to ${st.to}`],
    columns: [
      { header: 'Date', key: 'date', type: 'date' }, { header: 'Document', key: 'number' }, { header: 'Description', key: 'description', width: 50 },
      { header: 'Debit (INR)', key: 'debit', type: 'money' }, { header: 'Credit (INR)', key: 'credit', type: 'money' }, { header: 'Balance (INR)', key: 'balance', type: 'money' },
    ],
    rows: [{ description: 'Opening balance', balance: st.opening },
      ...st.rows.map((r) => ({ ...r, date: xl.dateOnly(r.day), debit: r.debit || null, credit: r.credit || null }))],
    totals: { description: 'Closing balance', debit: st.totals.debit, credit: st.totals.credit, balance: st.closing },
  });
  audit(req, 'statement.xlsx', bidderNo(st.user.id));
  await xl.send(res, wb, `statement-${bidderNo(st.user.id)}-${st.to}.xlsx`);
}));

module.exports = router;
