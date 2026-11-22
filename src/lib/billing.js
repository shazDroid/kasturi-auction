// Billing: sale orders (award documents), tax invoices (registration fee, buyer's commission, manual),
// invoice payments and the PDF documents. Every document freezes what it prints in its snapshot, so
// later edits to Settings, bidder profiles or lots never change an issued document.
const fs = require('fs');
const path = require('path');
const sanitizeHtml = require('sanitize-html');
const PDFDocument = require('pdfkit');
const db = require('../db');
const settings = require('./settings');
const mailer = require('./mailer');
const bidding = require('./bidding');
const { TZ, fmtINR, fmtDate, bidderNo } = require('./util');

class BillingError extends Error {}

const round2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Dates, financial years, numbering

const istParts = (d) => Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(d)).map((p) => [p.type, p.value])
);
/** IST calendar date "YYYY-MM-DD" of an instant. */
const istDate = (d) => { const p = istParts(d); return `${p.year}-${p.month}-${p.day}`; };

/** Indian financial year (April to March) of an instant, in IST: "2026-27". */
function financialYear(d = new Date()) {
  const p = istParts(d);
  const y = Number(p.year);
  const start = Number(p.month) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const NUMBERED = { sale_orders: true, invoices: true };
/**
 * Next number "<prefix>/<FY>/<0001>" for a table, inside the caller's transaction. An advisory lock
 * per prefix and year serialises concurrent issuers until they commit, so numbers are gap-free and
 * never repeat (a rolled-back transaction gives its number back).
 */
async function nextNumber(c, table, prefix, at) {
  if (!NUMBERED[table]) throw new Error('not a numbered table');
  const base = `${String(prefix || '').trim().replace(/\/+$/, '') || (table === 'invoices' ? 'INV' : 'SO')}/${financialYear(at)}/`;
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-number:${table}:${base}`]);
  const r = await c.query(
    `SELECT COALESCE(max(substring(number FROM length($1) + 1)::int), 0) AS n
       FROM ${table} WHERE left(number, length($1)) = $1 AND substring(number FROM length($1) + 1) ~ '^[0-9]{1,9}$'`, [base]
  );
  return base + String(r.rows[0].n + 1).padStart(4, '0');
}

// ---------------------------------------------------------------------------------------------
// Snapshots

/** Rich text or plain text -> plain text that keeps paragraphs and list items on their own lines. */
function htmlToText(value) {
  let s = String(value || '');
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.replace(/\r\n/g, '\n').trim();
  s = s.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\s*li[^>]*>/gi, '\n- ').replace(/<\/\s*(p|h[1-6]|li|tr|blockquote|div)\s*>/gi, '\n');
  s = sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} });
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n')
    .replace(/\n\n(?=- )/g, '\n').replace(/^- *$/gm, '').trim();
}

function companySnapshot() {
  return {
    name: settings.get('company_legal_name') || settings.get('site_name'),
    gstin: settings.get('company_gstin'),
    state: settings.get('company_state'),
    address: settings.get('contact_address'),
    phone: settings.get('contact_phone'),
    email: settings.get('contact_email'),
    site: mailer.url(''),
  };
}

const partySnapshot = (u) => ({
  user_id: u.id, bidder_no: bidderNo(u.id), name: u.name, company: u.company_name, address: u.address, city: u.city,
  state: u.state, pincode: u.pincode, gstin: u.gstin, pan: u.pan, email: u.email, phone: u.phone,
});

const normState = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * GST lines for a taxable value. Same state as the company: CGST + SGST at half the rate each;
 * otherwise (or when the bidder has no state) IGST. taxOverride is a tax amount already charged.
 */
function gstLines(taxable, percent, buyerState, taxOverride) {
  const pct = round2(percent);
  const tax = taxOverride === undefined || taxOverride === null ? round2(taxable * pct / 100) : round2(taxOverride);
  const companyState = normState(settings.get('company_state'));
  const intra = !!companyState && normState(buyerState) === companyState;
  if (!tax) return { intra, tax: 0, lines: [] };
  if (intra) {
    const half = round2(tax / 2);
    return { intra, tax, lines: [{ code: 'CGST', rate: pct / 2, amount: half }, { code: 'SGST', rate: pct / 2, amount: round2(tax - half) }] };
  }
  return { intra, tax, lines: [{ code: 'IGST', rate: pct, amount: tax }] };
}

/** Split of a snapshot's tax lines into the three GST heads. */
function taxHeads(snapshot) {
  const out = { cgst: 0, sgst: 0, igst: 0 };
  for (const t of (snapshot && snapshot.tax_lines) || []) {
    const k = String(t.code || '').toLowerCase();
    if (k in out) out[k] = round2(out[k] + Number(t.amount || 0));
  }
  return out;
}

const PAY_METHODS = {
  bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', razorpay: 'Razorpay', adjustment: 'Adjustment',
};
const KINDS = { registration_fee: 'Registration fee', commission: "Buyer's commission", other: 'Other' };
const STATUSES = { unpaid: 'Unpaid', part_paid: 'Part paid', paid: 'Paid', cancelled: 'Cancelled' };

/** Load and lock an awarded lot with everything a sale order or commission invoice needs. */
async function loadAwardedLot(c, lotId) {
  await c.query('SELECT id FROM lots WHERE id = $1 FOR UPDATE', [lotId]);
  const r = await c.query(
    `SELECT l.*, a.title AS a_title, a.location AS a_location, a.category AS a_category, a.inspection AS a_inspection,
            a.terms AS a_terms, a.starts_at AS a_starts_at, a.ends_at AS a_ends_at,
            s.name AS seller_name, s.location AS seller_location,
            b.id AS bid_id, b.amount AS rate, b.user_id AS winner_id, b.created_at AS bid_at
       FROM lots l JOIN auctions a ON a.id = l.auction_id
       LEFT JOIN sellers s ON s.id = a.seller_id
       LEFT JOIN bids b ON b.id = l.winning_bid_id AND NOT b.cancelled
      WHERE l.id = $1`, [lotId]
  );
  const lot = r.rows[0];
  if (!lot) throw new BillingError('This lot does not exist.');
  if (lot.result !== 'awarded' || !lot.bid_id) throw new BillingError(`Lot ${lot.lot_no} is not awarded, so no sale order or commission invoice can be issued. Award it on the Results page first.`);
  let pct = lot.commission_percent;
  if (pct === null || pct === undefined) {
    pct = Number(await bidding.commissionFor(c, lot.winner_id)) || 0;
    await c.query('UPDATE lots SET commission_percent = $2 WHERE id = $1 AND commission_percent IS NULL', [lot.id, pct]);
  }
  lot.commission_pct = round2(pct);
  lot.material_value = round2(lot.rate * lot.quantity);
  lot.commission = round2(lot.material_value * lot.commission_pct / 100);
  const u = (await c.query('SELECT * FROM users WHERE id = $1', [lot.winner_id])).rows[0];
  return { lot, user: u };
}

/** Commission figures for a lot (rate frozen on award, or the winner's current rate). Used by the Results page. */
async function commissionQuote(lotId) {
  return db.tx(async (c) => {
    const { lot } = await loadAwardedLot(c, lotId);
    return { percent: lot.commission_pct, materialValue: lot.material_value, commission: lot.commission };
  });
}

// ---------------------------------------------------------------------------------------------
// Sale orders

/** Issue the sale order for an awarded lot. Idempotent: returns the existing one. */
async function issueSaleOrder(lotId, adminId) {
  const res = await db.tx(async (c) => {
    const { lot, user } = await loadAwardedLot(c, lotId);
    const existing = (await c.query('SELECT * FROM sale_orders WHERE lot_id = $1', [lot.id])).rows[0];
    if (existing) {
      if (Number(existing.user_id) !== Number(lot.winner_id)) {
        throw new BillingError(`Sale order ${existing.number} was already issued for lot ${lot.lot_no} to another bidder. The winner has changed since; contact both bidders and correct the record by hand.`);
      }
      return { so: existing, fresh: false };
    }
    const at = new Date();
    const number = await nextNumber(c, 'sale_orders', settings.get('sale_order_prefix'), at);
    const gst = gstLines(lot.commission, settings.num('commission_gst_percent'), user.state);
    const snapshot = {
      version: 1,
      number,
      issued_at: at.toISOString(),
      company: companySnapshot(),
      buyer: partySnapshot(user),
      auction: {
        id: lot.auction_id, title: lot.a_title, category: lot.a_category, location: lot.a_location || lot.seller_location || '',
        closed_at: lot.ends_at, inspection: htmlToText(lot.a_inspection), terms: htmlToText(lot.a_terms),
      },
      seller: { name: lot.seller_name || '', location: lot.seller_location || '' },
      lot: {
        id: lot.id, lot_no: lot.lot_no, title: lot.title, description: htmlToText(lot.description).slice(0, 1500),
        quantity: round3(lot.quantity), unit: lot.unit, specs: Array.isArray(lot.specs) ? lot.specs.slice(0, 30) : [],
      },
      winning_bid_id: lot.bid_id,
      bid_at: lot.bid_at,
      rate: round2(lot.rate),
      material_value: lot.material_value,
      commission_percent: lot.commission_pct,
      commission: lot.commission,
      commission_gst_percent: settings.num('commission_gst_percent'),
      intra_state: gst.intra,
      tax_lines: gst.lines,
      commission_tax: gst.tax,
      commission_total: round2(lot.commission + gst.tax),
      sac: settings.get('invoice_sac'),
      terms: settings.get('sale_order_terms'),
      bank_details: settings.get('bank_details'),
    };
    const so = (await c.query(
      `INSERT INTO sale_orders(number, lot_id, user_id, snapshot, issued_by, issued_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [number, lot.id, user.id, JSON.stringify(snapshot), adminId || null, at]
    )).rows[0];
    return { so, fresh: true };
  });
  if (res.fresh) await emailSaleOrder(res.so.id);
  return res.so;
}

async function emailSaleOrder(id) {
  const so = await db.one('SELECT s.*, u.email, u.name FROM sale_orders s JOIN users u ON u.id = s.user_id WHERE s.id = $1', [id]);
  if (!so) return null;
  const s = so.snapshot;
  return mailer.send('sale_order_issued', so.email, {
    name: so.name, number: so.number, auction_title: s.auction.title, lot_no: s.lot.lot_no, lot_title: s.lot.title,
    amount: fmtINR(s.material_value), billing_url: mailer.url('/account/billing'),
  });
}

// ---------------------------------------------------------------------------------------------
// Invoices

async function insertInvoice(c, { kind, user, lotId, paymentId, lines, gstPercent, taxOverride, dueDays, note, ref, adminId, at }) {
  at = at || new Date();
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const gst = gstLines(subtotal, gstPercent, user.state, taxOverride);
  const total = round2(subtotal + gst.tax);
  const number = await nextNumber(c, 'invoices', settings.get('invoice_prefix'), at);
  const due = dueDays === null || dueDays === undefined ? null : new Date(at.getTime() + Math.max(0, dueDays) * 86400000);
  const snapshot = {
    version: 1,
    number,
    kind,
    issued_at: at.toISOString(),
    due_at: due ? due.toISOString() : null,
    company: companySnapshot(),
    bill_to: partySnapshot(user),
    place_of_supply: user.state || '',
    intra_state: gst.intra,
    gst_percent: round2(gstPercent),
    sac: settings.get('invoice_sac'),
    lines,
    tax_lines: gst.lines,
    subtotal,
    tax: gst.tax,
    total,
    ref: ref || {},
    note: note || '',
    bank_details: settings.get('bank_details'),
  };
  return (await c.query(
    `INSERT INTO invoices(number, kind, user_id, lot_id, payment_id, snapshot, subtotal, tax, total, status, issued_at, due_at, issued_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unpaid',$10,$11,$12) RETURNING *`,
    [number, kind, user.id, lotId || null, paymentId || null, JSON.stringify(snapshot), subtotal, gst.tax, total, at, due, adminId || null]
  )).rows[0];
}

const guessMethod = (note) => (/cheque|chq/i.test(note) ? 'cheque' : /\bcash\b/i.test(note) ? 'cash' : /\bupi\b/i.test(note) ? 'upi' : 'bank_transfer');

/** Raise the paid tax invoice for a paid registration fee payment. Idempotent per payment. */
async function invoiceForFeePayment(paymentId) {
  return db.tx(async (c) => {
    const p = (await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
    if (!p || p.status !== 'paid' || p.purpose !== 'registration_fee') return null;
    const existing = (await c.query('SELECT * FROM invoices WHERE payment_id = $1', [p.id])).rows[0];
    if (existing) return existing;
    const user = (await c.query('SELECT * FROM users WHERE id = $1', [p.user_id])).rows[0];
    const g = user.group_id ? (await c.query('SELECT name FROM bidder_groups WHERE id = $1', [user.group_id])).rows[0] : null;
    const base = round2(p.base_amount);
    const tax = round2(p.tax_amount);
    // The rate actually charged, from the payment itself (the setting may have changed since).
    const setPct = settings.num('fee_gst_percent');
    const pct = base > 0 ? (Math.abs(round2(base * setPct / 100) - tax) < 0.02 ? setPct : round2(tax / base * 100)) : setPct;
    const days = settings.num('fee_validity_days');
    const lines = [{
      description: `Bidder registration fee${days > 0 ? `, validity ${days} days` : ', one-time'}${g ? ` (${g.name})` : ''}`,
      hsn_sac: settings.get('invoice_sac'), qty: 1, unit: '', rate: base, amount: base,
    }];
    const ref = {
      payment_id: p.id, paid_at: p.paid_at, method: p.method,
      payment_ref: p.rp_payment_id || (p.method === 'offline' ? `OFFLINE-${p.id}` : ''),
    };
    const inv = await insertInvoice(c, { kind: 'registration_fee', user, paymentId: p.id, lines, gstPercent: pct, taxOverride: tax, dueDays: null, note: '', ref });
    // Rounding guard: the invoice total must equal what was collected.
    if (Math.abs(inv.total - round2(p.amount)) > 0.009) {
      await c.query('UPDATE invoices SET total = $2, snapshot = jsonb_set(snapshot, \'{total}\', to_jsonb($2::numeric)) WHERE id = $1', [inv.id, round2(p.amount)]);
      inv.total = round2(p.amount);
    }
    const method = p.method === 'razorpay' ? 'razorpay' : guessMethod(p.note);
    await c.query(
      `INSERT INTO invoice_payments(invoice_id, amount, method, reference, paid_on, note) VALUES($1,$2,$3,$4,$5,$6)`,
      [inv.id, inv.total, method, (p.rp_payment_id || p.note || `OFFLINE-${p.id}`).slice(0, 200), istDate(p.paid_at || new Date()),
        p.method === 'offline' ? 'Recorded offline' : 'Paid online']
    );
    await c.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
    inv.status = 'paid';
    return inv;
  });
}

/** Paid fee payments that have no invoice yet. */
const missingFeeInvoices = async () => (await db.one(
  `SELECT count(*)::int AS n FROM payments p WHERE p.status = 'paid' AND p.purpose = 'registration_fee'
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = p.id)`
)).n;

/** Raise invoices for every paid fee payment that lacks one. Returns the number raised. */
async function backfillFeeInvoices() {
  const rows = await db.many(
    `SELECT p.id FROM payments p WHERE p.status = 'paid' AND p.purpose = 'registration_fee'
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = p.id) ORDER BY p.paid_at NULLS FIRST, p.id`
  );
  let n = 0;
  for (const r of rows) if (await invoiceForFeePayment(r.id)) n++;
  return n;
}

/** Buyer's commission invoice for an awarded lot. Idempotent per lot; null when the commission is 0. */
async function issueCommissionInvoice(lotId, adminId) {
  const res = await db.tx(async (c) => {
    const { lot, user } = await loadAwardedLot(c, lotId);
    const existing = (await c.query(`SELECT * FROM invoices WHERE lot_id = $1 AND kind = 'commission' AND status <> 'cancelled' ORDER BY id LIMIT 1`, [lot.id])).rows[0];
    if (existing) return { inv: existing, fresh: false };
    if (lot.commission <= 0) return { inv: null, fresh: false };
    const so = (await c.query('SELECT number FROM sale_orders WHERE lot_id = $1', [lot.id])).rows[0];
    const lines = [{
      description: `Buyer's commission at ${lot.commission_pct}% on the material value of ${fmtINR(lot.material_value)} `
        + `(${round3(lot.quantity)} ${lot.unit} at ${fmtINR(lot.rate)} per ${lot.unit}). Lot ${lot.lot_no}: ${lot.title}. Auction: ${lot.a_title}.`,
      hsn_sac: settings.get('invoice_sac'), qty: 1, unit: '', rate: lot.commission, amount: lot.commission,
    }];
    const ref = {
      auction_id: lot.auction_id, auction_title: lot.a_title, lot_id: lot.id, lot_no: lot.lot_no, lot_title: lot.title,
      sale_order: so ? so.number : '', material_value: lot.material_value, commission_percent: lot.commission_pct,
    };
    const inv = await insertInvoice(c, {
      kind: 'commission', user, lotId: lot.id, lines, gstPercent: settings.num('commission_gst_percent'),
      dueDays: settings.num('invoice_due_days'), ref, adminId,
    });
    return { inv, fresh: true };
  });
  if (res.fresh) await emailInvoice(res.inv.id);
  return res.inv;
}

/**
 * Manual invoice (kind 'other'). lines: [{description, qty, rate}]. Throws BillingError on bad input.
 */
async function createManualInvoice({ userId, lines, gstPercent, dueDays, note }, adminId) {
  const clean = [];
  (lines || []).forEach((l, i) => {
    const description = String(l.description || '').trim().slice(0, 300);
    const qty = Number(l.qty);
    const rate = Number(l.rate);
    if (!description && !l.qty && !l.rate) return;
    if (!description) throw new BillingError(`Line ${i + 1}: enter a description.`);
    if (!Number.isFinite(qty) || qty <= 0) throw new BillingError(`Line ${i + 1}: quantity must be a number above 0.`);
    if (!Number.isFinite(rate) || rate < 0) throw new BillingError(`Line ${i + 1}: rate must be 0 or more.`);
    clean.push({ description, hsn_sac: settings.get('invoice_sac'), qty: round3(qty), unit: String(l.unit || '').trim().slice(0, 12), rate: round2(rate), amount: round2(qty * rate) });
  });
  if (!clean.length) throw new BillingError('Add at least one line with a description, quantity and rate.');
  const pct = Number(gstPercent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 40) throw new BillingError('GST must be between 0 and 40 percent.');
  const days = dueDays === '' || dueDays === undefined || dueDays === null ? settings.num('invoice_due_days') : Number(dueDays);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new BillingError('Payment terms must be a whole number of days between 0 and 365.');
  if (round2(clean.reduce((s, l) => s + l.amount, 0)) <= 0) throw new BillingError('The invoice total must be above 0.');
  const res = await db.tx(async (c) => {
    const user = (await c.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (!user) throw new BillingError('Choose the bidder to invoice.');
    return insertInvoice(c, { kind: 'other', user, lines: clean, gstPercent: pct, dueDays: days, note: String(note || '').trim().slice(0, 1000), adminId });
  });
  await emailInvoice(res.id);
  return res;
}

function invoiceDescription(inv) {
  const s = inv.snapshot || {};
  if (inv.kind === 'registration_fee') return 'Bidder registration fee';
  if (inv.kind === 'commission' && s.ref) return `Buyer's commission, lot ${s.ref.lot_no}: ${s.ref.lot_title}`;
  return (s.lines && s.lines[0] && s.lines[0].description) || KINDS[inv.kind] || inv.kind;
}

async function emailInvoice(id) {
  const inv = await db.one('SELECT i.*, u.email, u.name FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.id = $1', [id]);
  if (!inv || inv.status === 'cancelled') return null;
  return mailer.send('invoice_issued', inv.email, {
    name: inv.name, number: inv.number, description: invoiceDescription(inv), total: fmtINR(inv.total),
    due_on: inv.due_at ? fmtDate(inv.due_at) : 'Paid', billing_url: mailer.url('/account/billing'),
  });
}

const paidSql = '(SELECT COALESCE(sum(amount), 0) FROM invoice_payments ip WHERE ip.invoice_id = i.id)';

async function refreshStatus(c, invoiceId) {
  const r = (await c.query(`SELECT i.total, i.status, ${paidSql} AS paid FROM invoices i WHERE i.id = $1`, [invoiceId])).rows[0];
  if (!r || r.status === 'cancelled') return r ? r.status : null;
  const status = r.paid <= 0 ? 'unpaid' : round2(r.paid) >= round2(r.total) ? 'paid' : 'part_paid';
  await c.query('UPDATE invoices SET status = $2 WHERE id = $1', [invoiceId, status]);
  return status;
}

/** Record money received against an invoice. Cannot exceed the balance. */
async function recordPayment(invoiceId, { amount, method, reference, paidOn, note }, adminId) {
  return db.tx(async (c) => {
    const inv = (await c.query(`SELECT i.*, ${paidSql} AS paid FROM invoices i WHERE i.id = $1 FOR UPDATE`, [invoiceId])).rows[0];
    if (!inv) throw new BillingError('This invoice does not exist.');
    if (inv.status === 'cancelled') throw new BillingError(`Invoice ${inv.number} is cancelled, so no payment can be recorded against it.`);
    const amt = round2(amount);
    const balance = round2(inv.total - inv.paid);
    if (!Number.isFinite(Number(amount)) || amt <= 0) throw new BillingError('Enter the amount received, above 0.');
    if (balance <= 0) throw new BillingError(`Invoice ${inv.number} is already paid in full.`);
    if (amt > balance) throw new BillingError(`The amount ${fmtINR(amt)} is more than the balance due of ${fmtINR(balance)}. Record ${fmtINR(balance)} or less.`);
    if (!PAY_METHODS[method]) throw new BillingError('Choose how the payment was made.');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(paidOn || '')) ? paidOn : istDate(new Date());
    if (isNaN(new Date(day + 'T00:00:00+05:30'))) throw new BillingError('Enter a valid payment date.');
    if (day > istDate(new Date())) throw new BillingError('The payment date cannot be in the future.');
    const row = (await c.query(
      `INSERT INTO invoice_payments(invoice_id, amount, method, reference, paid_on, note, recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [inv.id, amt, method, String(reference || '').trim().slice(0, 200), day, String(note || '').trim().slice(0, 500), adminId || null]
    )).rows[0];
    row.status = await refreshStatus(c, inv.id);
    row.number = inv.number;
    return row;
  });
}

/** Delete a recorded payment row and recompute the invoice status. Returns the removed row. */
async function removePayment(paymentRowId) {
  return db.tx(async (c) => {
    const p = (await c.query('SELECT * FROM invoice_payments WHERE id = $1', [paymentRowId])).rows[0];
    if (!p) throw new BillingError('This payment record does not exist.');
    const inv = (await c.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [p.invoice_id])).rows[0];
    if (inv.status === 'cancelled') throw new BillingError('The invoice is cancelled.');
    await c.query('DELETE FROM invoice_payments WHERE id = $1', [p.id]);
    p.status = await refreshStatus(c, inv.id);
    p.number = inv.number;
    return p;
  });
}

/** Cancel an invoice that has no payments. The number stays used. */
async function cancelInvoice(id, note) {
  return db.tx(async (c) => {
    const inv = (await c.query(`SELECT i.*, ${paidSql} AS paid FROM invoices i WHERE i.id = $1 FOR UPDATE`, [id])).rows[0];
    if (!inv) throw new BillingError('This invoice does not exist.');
    if (inv.status === 'cancelled') throw new BillingError(`Invoice ${inv.number} is already cancelled.`);
    if (inv.paid > 0) throw new BillingError(`Invoice ${inv.number} has payments recorded against it. Remove them first, or raise a separate adjustment.`);
    const n = String(note || '').trim().slice(0, 500);
    if (!n) throw new BillingError('Enter the reason for cancelling.');
    await c.query(`UPDATE invoices SET status = 'cancelled', cancel_note = $2 WHERE id = $1`, [inv.id, n]);
    return { ...inv, status: 'cancelled', cancel_note: n };
  });
}

async function getInvoice(id) {
  const inv = await db.one(`SELECT i.*, ${paidSql} AS paid FROM invoices i WHERE i.id = $1`, [id]);
  if (!inv) return null;
  inv.balance = inv.status === 'cancelled' ? 0 : round2(inv.total - inv.paid);
  inv.payments = await db.many(
    `SELECT ip.*, ip.paid_on::text AS paid_on, ad.name AS recorded_by_name FROM invoice_payments ip LEFT JOIN admins ad ON ad.id = ip.recorded_by
      WHERE ip.invoice_id = $1 ORDER BY ip.paid_on, ip.id`, [id]
  );
  return inv;
}

/** A bidder's sale orders and invoices, newest first. */
async function listForUser(userId) {
  const saleOrders = (await db.many(
    `SELECT s.id, s.number, s.issued_at, s.lot_id, s.snapshot, l.buyer_paid_at, l.lifted_at
       FROM sale_orders s LEFT JOIN lots l ON l.id = s.lot_id WHERE s.user_id = $1 ORDER BY s.issued_at DESC, s.id DESC`, [userId]
  )).map((s) => ({
    id: s.id, number: s.number, issued_at: s.issued_at, lot_id: s.lot_id,
    auction_title: s.snapshot.auction.title, lot_no: s.snapshot.lot.lot_no, lot_title: s.snapshot.lot.title,
    quantity: s.snapshot.lot.quantity, unit: s.snapshot.lot.unit, rate: s.snapshot.rate,
    material_value: s.snapshot.material_value, commission: s.snapshot.commission, commission_total: s.snapshot.commission_total,
    total: s.snapshot.material_value, status: s.lifted_at ? 'lifted' : s.buyer_paid_at ? 'buyer_paid' : 'issued',
    buyer_paid_at: s.buyer_paid_at, lifted_at: s.lifted_at,
  }));
  const invoices = (await db.many(
    `SELECT i.id, i.number, i.kind, i.issued_at, i.due_at, i.subtotal, i.tax, i.total, i.status, i.snapshot, i.lot_id, ${paidSql} AS paid
       FROM invoices i WHERE i.user_id = $1 ORDER BY i.issued_at DESC, i.id DESC`, [userId]
  )).map((i) => ({
    id: i.id, number: i.number, kind: i.kind, kind_label: KINDS[i.kind] || i.kind, issued_at: i.issued_at, due_at: i.due_at,
    subtotal: i.subtotal, tax: i.tax, total: i.total, paid: i.paid, balance: i.status === 'cancelled' ? 0 : round2(i.total - i.paid),
    status: i.status, status_label: STATUSES[i.status] || i.status, description: invoiceDescription(i),
    auction_title: (i.snapshot.ref && i.snapshot.ref.auction_title) || '', lot_title: (i.snapshot.ref && i.snapshot.ref.lot_title) || '',
    overdue: !!i.due_at && ['unpaid', 'part_paid'].includes(i.status) && new Date(i.due_at) < new Date(),
  }));
  return { saleOrders, invoices };
}

// ---------------------------------------------------------------------------------------------
// Amounts in words (Indian numbering)

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const three = (n) => [n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' : '', n % 100 ? two(n % 100) : ''].filter(Boolean).join(' ');
function intWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const th = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(intWords(crore) + ' Crore');
  if (lakh) parts.push(two(lakh) + ' Lakh');
  if (th) parts.push(two(th) + ' Thousand');
  if (n) parts.push(three(n));
  return parts.join(' ');
}
/** 12345678.5 -> "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only" */
function amountInWords(amount) {
  const paiseTotal = Math.round(Math.abs(Number(amount) || 0) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  return `Rupees ${intWords(rupees)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

// ---------------------------------------------------------------------------------------------
// PDF

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_R = path.join(FONT_DIR, 'DejaVuSansCondensed.ttf');
const FONT_B = path.join(FONT_DIR, 'DejaVuSansCondensed-Bold.ttf');
const HAS_FONT = fs.existsSync(FONT_R) && fs.existsSync(FONT_B);
const RUPEE = HAS_FONT ? '₹' : 'Rs. ';

const n2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n3 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
const num2 = (n) => n2.format(round2(n));
const money = (n) => (Number(n) < 0 ? '-' : '') + RUPEE + n2.format(Math.abs(round2(n)));
const qtyFmt = (n) => n3.format(Number(n) || 0);
const pdfDate = (d) => (d ? fmtDate(d) : '');
const C = { ink: '#16202c', muted: '#5b6878', line: '#c9d1db', soft: '#e4e9ef', head: '#eef1f5' };

/** Small layout engine over pdfkit with a running y and page breaks. */
function makeWriter(doc) {
  const M = { l: 42, r: 42, t: 42, b: 58 };
  const W = doc.page.width - M.l - M.r;
  const w = {
    doc, M, W, x: M.l, y: M.t,
    bottom: () => doc.page.height - M.b,
    font: (bold, size, color) => doc.font(HAS_FONT ? (bold ? 'B' : 'R') : (bold ? 'Helvetica-Bold' : 'Helvetica')).fontSize(size).fillColor(color || C.ink),
    h: (str, width, opts = {}) => doc.heightOfString(String(str ?? ''), { width, lineGap: opts.lineGap ?? 1 }),
    newPage() { doc.addPage(); w.y = M.t; if (w.onPage) w.onPage(); },
    ensure(hgt) { if (w.y + hgt > w.bottom()) { w.newPage(); return true; } return false; },
    /** Draw text at (x, y) in a box of width; never lets pdfkit flow it onto a new page. Returns height. */
    put(str, x, y, width, opts = {}) {
      const s = String(str ?? '');
      doc.text(s, x, y, { width, align: opts.align || 'left', lineGap: opts.lineGap ?? 1, lineBreak: true, height: opts.height });
      return w.h(s, width, opts);
    },
    rule(color = C.line, width = 0.7) { doc.save().moveTo(M.l, w.y).lineTo(M.l + W, w.y).lineWidth(width).strokeColor(color).stroke().restore(); },
    /** Flowing paragraph text that may cross pages, split line by line. */
    para(str, { size = 8.5, color = C.ink, bold = false, indent = 0, gap = 3 } = {}) {
      const width = W - indent;
      w.font(bold, size, color);
      for (const raw of String(str || '').split('\n')) {
        const line = raw.trimEnd();
        if (!line) { w.y += size * 0.6; continue; }
        // Split into word-wrapped rows so a page break can fall between any two rows.
        const rows = wrapRows(doc, line, width);
        for (const row of rows) {
          const rh = w.h(row, width) ;
          w.ensure(rh);
          w.font(bold, size, color);
          w.put(row, M.l + indent, w.y, width);
          w.y += rh;
        }
      }
      w.y += gap;
    },
    heading(str) { w.font(true, 9.5); const hh = w.h(str, W); w.ensure(hh + 18); w.font(true, 9.5); w.put(str, M.l, w.y, W); w.y += hh + 4; },
  };
  return w;
}

/** Break one line of text into rows that fit width with the current font. Long unbroken words are split. */
function wrapRows(doc, text, width) {
  const words = text.split(/(\s+)/);
  const rows = [];
  let cur = '';
  const fits = (s) => doc.widthOfString(s) <= width;
  for (const part of words) {
    if (!part) continue;
    if (fits(cur + part)) { cur += part; continue; }
    if (/^\s+$/.test(part)) { rows.push(cur); cur = ''; continue; }
    if (cur.trim()) rows.push(cur.trimEnd());
    cur = '';
    let p = part;
    while (!fits(p)) {
      let k = p.length - 1;
      while (k > 1 && !fits(p.slice(0, k))) k--;
      rows.push(p.slice(0, k));
      p = p.slice(k);
    }
    cur = p;
  }
  if (cur.trim() || !rows.length) rows.push(cur.trimEnd());
  return rows;
}

function pdfBuffer(meta, build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: meta.title, Author: meta.author || '', Creator: meta.author || '' } });
    if (HAS_FONT) { doc.registerFont('R', FONT_R); doc.registerFont('B', FONT_B); }
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const w = makeWriter(doc);
      build(w);
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const y = doc.page.height - w.M.b + 18;
        doc.save().moveTo(w.M.l, y - 6).lineTo(w.M.l + w.W, y - 6).lineWidth(0.5).strokeColor(C.line).stroke().restore();
        w.font(false, 7.5, C.muted);
        doc.text(`${meta.footer}. This is a computer generated document and does not need a signature.`, w.M.l, y, { width: w.W - 80, lineBreak: false, ellipsis: true });
        doc.text(`Page ${i - range.start + 1} of ${range.count}`, w.M.l + w.W - 80, y, { width: 80, align: 'right', lineBreak: false });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

/** Company header (left) and document title with key facts (right). */
function drawHeader(w, company, title, facts) {
  const { doc, M, W } = w;
  const rightW = 205;
  const leftW = W - rightW - 20;
  const top = w.y;
  let ly = top;
  w.font(true, 14); ly += w.put(company.name || '', M.l, ly, leftW) + 3;
  const addr = [company.address, company.gstin ? `GSTIN: ${company.gstin}` : '', company.state ? `State: ${company.state}` : '',
    [company.phone, company.email].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  w.font(false, 8.5, C.muted); ly += w.put(addr, M.l, ly, leftW, { lineGap: 1.5 });
  let ry = top;
  w.font(true, 17); ry += w.put(title, M.l + W - rightW, ry, rightW, { align: 'right' }) + 6;
  const lw = 78;
  for (const [k, v] of facts) {
    if (!v) continue;
    w.font(false, 8.5, C.muted); w.put(k, M.l + W - rightW, ry, lw);
    w.font(true, 8.5); const hv = w.put(v, M.l + W - rightW + lw, ry, rightW - lw, { align: 'right' });
    ry += Math.max(hv, 11) + 2;
  }
  w.y = Math.max(ly, ry) + 10;
  w.rule(C.ink, 1);
  w.y += 10;
  doc.fillColor(C.ink);
}

function partyText(p) {
  const loc = [p.city, p.state, p.pincode].filter(Boolean).join(', ');
  return {
    title: p.company || p.name,
    lines: [p.company ? p.name : '', p.address, loc, p.gstin ? `GSTIN: ${p.gstin}` : 'GSTIN: not registered', p.pan ? `PAN: ${p.pan}` : '',
      `Bidder no.: ${p.bidder_no}`, [p.phone, p.email].filter(Boolean).join(', ')].filter(Boolean),
  };
}

/** Two side-by-side blocks: [{heading, title, lines}] or [{heading, kv: [[k, v]]}]. */
function drawBlocks(w, blocks) {
  const { M, W } = w;
  const gap = 20;
  const bw = (W - gap) / 2;
  const measure = (b) => {
    w.font(true, 8); let h = w.h(b.heading, bw) + 4;
    if (b.title) { w.font(true, 9.5); h += w.h(b.title, bw) + 2; }
    w.font(false, 8.5);
    for (const l of b.lines || []) h += w.h(l, bw) + 1;
    for (const [, v] of b.kv || []) h += Math.max(w.h(v, bw - 92), 10) + 2;
    return h;
  };
  const hgt = Math.max(...blocks.map(measure));
  w.ensure(hgt + 10);
  const top = w.y;
  blocks.forEach((b, i) => {
    const x = M.l + i * (bw + gap);
    let y = top;
    w.font(true, 8, C.muted); y += w.put(b.heading, x, y, bw) + 4;
    if (b.title) { w.font(true, 9.5); y += w.put(b.title, x, y, bw) + 2; }
    w.font(false, 8.5);
    for (const l of b.lines || []) y += w.put(l, x, y, bw) + 1;
    for (const [k, v] of b.kv || []) {
      w.font(false, 8.5, C.muted); w.put(k, x, y, 90);
      w.font(false, 8.5); y += Math.max(w.put(v, x + 92, y, bw - 92), 10) + 2;
    }
  });
  w.y = top + hgt + 12;
}

/**
 * Table with a header row repeated on every page. cols: [{label, width (fraction), align}]; rows: arrays of strings.
 */
function drawTable(w, cols, rows) {
  const { doc, M, W } = w;
  const pad = 5;
  const widths = cols.map((c) => c.width * W);
  const xs = widths.reduce((acc, cw, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M.l); return acc; }, []);
  const header = () => {
    w.font(true, 8);
    const hh = Math.max(...cols.map((c, i) => w.h(c.label, widths[i] - pad * 2))) + pad * 2;
    doc.save().rect(M.l, w.y, W, hh).fill(C.head).restore();
    cols.forEach((c, i) => { w.font(true, 8); w.put(c.label, xs[i] + pad, w.y + pad, widths[i] - pad * 2, { align: c.align }); });
    w.y += hh;
    doc.save().moveTo(M.l, w.y).lineTo(M.l + W, w.y).lineWidth(0.7).strokeColor(C.line).stroke().restore();
  };
  w.ensure(40);
  header();
  const drawRow = (row) => {
    w.font(false, 8.5);
    const rh = Math.max(...row.map((v, i) => w.h(v, widths[i] - pad * 2))) + pad * 2;
    if (w.ensure(rh)) header();
    row.forEach((v, i) => { w.font(!!cols[i].bold, 8.5); w.put(v, xs[i] + pad, w.y + pad, widths[i] - pad * 2, { align: cols[i].align }); });
    w.y += rh;
    doc.save().moveTo(M.l, w.y).lineTo(M.l + W, w.y).lineWidth(0.5).strokeColor(C.soft).stroke().restore();
  };
  const wide = cols.reduce((best, c, i) => (c.width > cols[best].width ? i : best), 0);
  for (const row of rows) {
    w.font(false, 8.5);
    const rh = Math.max(...row.map((v, i) => w.h(v, widths[i] - pad * 2))) + pad * 2;
    if (rh <= w.bottom() - w.M.t - 60) { drawRow(row); continue; }
    // A row taller than a page (very long text) is split into several rows of whole lines.
    w.font(false, 8.5);
    const parts = String(row[wide] || '').split('\n').flatMap((l) => wrapRows(doc, l, widths[wide] - pad * 2));
    for (let k = 0; k < parts.length; k += 40) {
      drawRow(row.map((v, i) => (i === wide ? parts.slice(k, k + 40).join('\n') : k ? '' : v)));
    }
  }
  w.y += 8;
}

/** Right-aligned totals block: [[label, value, {bold}]]. */
function drawTotals(w, rows, bw = 270) {
  const { doc, M, W } = w;
  const x = M.l + W - bw;
  const vw = 105;
  w.font(false, 9);
  const hgt = rows.reduce((s, r) => s + Math.max(w.h(r[0], bw - vw - 10), 11) + 5, 0) + 6;
  w.ensure(hgt);
  for (const [label, value, o = {}] of rows) {
    if (o.rule) { doc.save().moveTo(x, w.y).lineTo(x + bw, w.y).lineWidth(0.8).strokeColor(C.ink).stroke().restore(); w.y += 4; }
    w.font(!!o.bold, o.bold ? 10 : 9, o.muted ? C.muted : C.ink);
    const hl = w.put(label, x, w.y, bw - vw - 10);
    w.font(!!o.bold, o.bold ? 10 : 9);
    w.put(value, x + bw - vw, w.y, vw, { align: 'right' });
    w.y += Math.max(hl, 11) + 5;
  }
  w.y += 2;
}

function drawWords(w, label, amount) {
  const { M, W } = w;
  const text = amountInWords(amount);
  w.font(false, 8.5);
  const hgt = w.h(text, W - 110) + 6;
  w.ensure(hgt);
  w.font(true, 8.5, C.muted); w.put(label, M.l, w.y, 108);
  w.font(true, 8.5); w.y += w.put(text, M.l + 110, w.y, W - 110) + 6;
}

function drawBox(w, lines) {
  const { doc, M, W } = w;
  w.font(true, 9);
  const hgt = lines.reduce((s, l) => s + w.h(l, W - 20) + 2, 0) + 14;
  w.ensure(hgt + 6);
  doc.save().rect(M.l, w.y, W, hgt).lineWidth(0.7).strokeColor(C.line).stroke().restore();
  let y = w.y + 7;
  lines.forEach((l, i) => { w.font(i === 0, 9); y += w.put(l, M.l + 10, y, W - 20) + 2; });
  w.y += hgt + 10;
}

function drawSection(w, heading, text) {
  if (!String(text || '').trim()) return;
  w.heading(heading);
  w.para(text, { size: 8.5 });
  w.y += 4;
}

const specsText = (specs) => (specs || []).filter((s) => s && s.label).map((s) => `${s.label}: ${s.value}`).join('; ');

async function saleOrderPdf(id) {
  const so = await db.one('SELECT * FROM sale_orders WHERE id = $1', [id]);
  if (!so) return null;
  const s = so.snapshot;
  const co = s.company;
  return pdfBuffer({ title: `Sale order ${so.number}`, author: co.name, footer: `Sale order ${so.number}` }, (w) => {
    drawHeader(w, co, 'Sale order', [
      ['Number', so.number], ['Date', pdfDate(s.issued_at)], ['Auction closed', pdfDate(s.auction.closed_at)],
    ]);
    const buyer = partyText(s.buyer);
    drawBlocks(w, [
      { heading: 'Buyer', title: buyer.title, lines: buyer.lines },
      { heading: 'Auction and material', kv: [
        ['Auction', s.auction.title], ['Lot', `Lot ${s.lot.lot_no}`], ['Seller', s.seller.name || 'Not given'],
        ['Material location', s.auction.location || s.seller.location || 'As per auction terms'],
        ['Category', s.auction.category], ['Place of supply', s.buyer.state || 'Not given'],
      ].filter((r) => r[1]) },
    ]);
    w.font(false, 9);
    w.para(`${co.name} confirms that the lot below has been awarded to the buyer named above at the winning bid in the auction. The material value is payable to the seller as per the auction terms. The buyer's commission is payable separately to ${co.name}.`, { size: 8.5, gap: 8 });
    const desc = [s.lot.title, specsText(s.lot.specs)].filter(Boolean).join('\n');
    drawTable(w, [
      { label: 'Lot', width: 0.07 }, { label: 'Description', width: 0.43 }, { label: 'Quantity', width: 0.12, align: 'right' },
      { label: 'Unit', width: 0.07 }, { label: `Rate (${RUPEE.trim()} per unit)`, width: 0.14, align: 'right' }, { label: `Value (${RUPEE.trim()})`, width: 0.17, align: 'right' },
    ], [[String(s.lot.lot_no), desc, qtyFmt(s.lot.quantity), s.lot.unit, num2(s.rate), num2(s.material_value)]]);
    drawTotals(w, [
      ['Material value payable to the seller', money(s.material_value), { bold: true }],
    ], 360);
    drawWords(w, 'Material value in words', s.material_value);
    w.y += 6;

    w.heading(`Buyer's commission payable to ${co.name}`);
    const tax = (s.tax_lines || []).map((t) => [`${t.code} at ${t.rate}%`, money(t.amount)]);
    if (s.commission > 0) {
      drawTable(w, [
        { label: 'Description', width: 0.55 }, { label: 'SAC', width: 0.13 }, { label: 'Rate', width: 0.12, align: 'right' }, { label: `Amount (${RUPEE.trim()})`, width: 0.2, align: 'right' },
      ], [[`Buyer's commission on the material value of ${money(s.material_value)}`, s.sac || '', `${s.commission_percent}%`, num2(s.commission)]]);
      drawTotals(w, [
        ['Commission', money(s.commission)],
        ...tax,
        ['Total commission payable', money(s.commission_total), { bold: true, rule: true }],
      ]);
      drawWords(w, 'Commission in words', s.commission_total);
      w.font(false, 8, C.muted);
      w.para('A tax invoice for the commission is issued separately.', { size: 8, color: C.muted, gap: 6 });
    } else {
      w.para('No buyer\'s commission is payable on this lot.', { size: 8.5, gap: 6 });
      drawWords(w, 'Commission in words', 0);
    }
    w.y += 4;
    drawSection(w, 'Inspection and lifting', s.auction.inspection);
    drawSection(w, 'Auction terms', s.auction.terms);
    drawSection(w, 'Terms of this sale order', s.terms);
    drawSection(w, `Bank details for the commission payment to ${co.name}`, s.bank_details);
  });
}

async function invoicePdf(id) {
  const inv = await getInvoice(id);
  if (!inv) return null;
  const s = inv.snapshot;
  const co = s.company;
  const cancelled = inv.status === 'cancelled';
  return pdfBuffer({ title: `Tax invoice ${inv.number}`, author: co.name, footer: `Tax invoice ${inv.number}` }, (w) => {
    drawHeader(w, co, cancelled ? 'Tax invoice (cancelled)' : 'Tax invoice', [
      ['Invoice no.', inv.number], ['Invoice date', pdfDate(s.issued_at)], ['Due date', s.due_at ? pdfDate(s.due_at) : ''],
    ]);
    const bt = partyText(s.bill_to);
    const kv = [['Place of supply', s.place_of_supply || 'Not given'], ['Tax type', s.intra_state ? 'Intra-state (CGST + SGST)' : 'Inter-state (IGST)'], ['SAC', s.sac]];
    if (s.ref && s.ref.auction_title) kv.push(['Auction', s.ref.auction_title]);
    if (s.ref && s.ref.lot_no) kv.push(['Lot', `Lot ${s.ref.lot_no}: ${s.ref.lot_title}`]);
    if (s.ref && s.ref.sale_order) kv.push(['Sale order', s.ref.sale_order]);
    if (s.ref && s.ref.payment_ref) kv.push(['Payment ref.', s.ref.payment_ref]);
    drawBlocks(w, [{ heading: 'Bill to', title: bt.title, lines: bt.lines }, { heading: 'Supply details', kv: kv.filter((r) => r[1]) }]);
    drawTable(w, [
      { label: '#', width: 0.05 }, { label: 'Description', width: 0.43 }, { label: 'SAC', width: 0.1 },
      { label: 'Qty', width: 0.09, align: 'right' }, { label: `Rate (${RUPEE.trim()})`, width: 0.15, align: 'right' }, { label: `Amount (${RUPEE.trim()})`, width: 0.18, align: 'right' },
    ], s.lines.map((l, i) => [String(i + 1), l.description, l.hsn_sac || s.sac || '', qtyFmt(l.qty) + (l.unit ? ' ' + l.unit : ''), num2(l.rate), num2(l.amount)]));
    drawTotals(w, [
      ['Taxable value', money(s.subtotal)],
      ...(s.tax_lines || []).map((t) => [`${t.code} at ${t.rate}%`, money(t.amount)]),
      ...(s.tax_lines && s.tax_lines.length ? [] : [['GST', money(0), { muted: true }]]),
      ['Invoice total', money(inv.total), { bold: true, rule: true }],
    ]);
    drawWords(w, 'Amount in words', inv.total);
    w.y += 4;
    if (cancelled) drawBox(w, ['This invoice is cancelled.', `Reason: ${inv.cancel_note}`]);
    else if (inv.status === 'paid') {
      const last = inv.payments[inv.payments.length - 1];
      drawBox(w, ['Paid in full', `Received ${money(inv.paid)}${last ? ` on ${pdfDate(last.paid_on + 'T12:00:00+05:30')} by ${PAY_METHODS[last.method] || last.method}${last.reference ? `, reference ${last.reference}` : ''}` : ''}.`]);
    } else {
      drawBox(w, [`Balance due: ${money(inv.balance)}${s.due_at ? ` by ${pdfDate(s.due_at)}` : ''}`,
        inv.paid > 0 ? `Received so far: ${money(inv.paid)}.` : 'No payment has been received yet.']);
    }
    if (s.note) drawSection(w, 'Note', s.note);
    if (inv.status !== 'paid' && !cancelled) drawSection(w, 'Bank details', s.bank_details);
    w.font(false, 8, C.muted);
    w.para('Tax is not payable on reverse charge basis.', { size: 8, color: C.muted });
  });
}

/** Statement of account PDF: rows [{date, type, number, description, debit, credit, balance}]. */
function statementPdf({ user, from, to, opening, rows, closing }) {
  const co = companySnapshot();
  return pdfBuffer({ title: `Statement ${bidderNo(user.id)}`, author: co.name, footer: `Statement of account ${bidderNo(user.id)}` }, (w) => {
    drawHeader(w, co, 'Statement of account', [['Bidder no.', bidderNo(user.id)], ['From', from ? pdfDate(from + 'T12:00:00+05:30') : 'Start'], ['To', pdfDate(to + 'T12:00:00+05:30')]]);
    const p = partyText(partySnapshot(user));
    drawBlocks(w, [{ heading: 'Account', title: p.title, lines: p.lines }, { heading: 'Summary', kv: [['Opening balance', money(opening)], ['Closing balance', money(closing)]] }]);
    drawTable(w, [
      { label: 'Date', width: 0.12 }, { label: 'Document', width: 0.2 }, { label: 'Description', width: 0.26 },
      { label: `Debit (${RUPEE.trim()})`, width: 0.14, align: 'right' }, { label: `Credit (${RUPEE.trim()})`, width: 0.14, align: 'right' }, { label: `Balance (${RUPEE.trim()})`, width: 0.14, align: 'right' },
    ], [['', '', 'Opening balance', '', '', num2(opening)], ...rows.map((r) => [pdfDate(r.date), r.number, r.description, r.debit ? num2(r.debit) : '', r.credit ? num2(r.credit) : '', num2(r.balance)])]);
    drawTotals(w, [['Closing balance', money(closing), { bold: true, rule: true }]]);
    drawWords(w, closing < 0 ? 'Credit in words' : 'Balance in words', closing);
  });
}

/** SQL for a lot's commission rate: frozen on the lot, else the winner's group, else the default bound to $n. Needs aliases l and g (winner's group). */
const commissionPctSql = (n) => `COALESCE(l.commission_percent, g.commission_percent, $${n}::numeric)`;

module.exports = {
  BillingError, commissionPctSql, KINDS, STATUSES, PAY_METHODS,
  financialYear, istDate, amountInWords, htmlToText, gstLines, taxHeads, round2,
  invoiceForFeePayment, backfillFeeInvoices, missingFeeInvoices,
  issueSaleOrder, issueCommissionInvoice, createManualInvoice, commissionQuote,
  recordPayment, removePayment, cancelInvoice, getInvoice, emailSaleOrder, emailInvoice, invoiceDescription,
  saleOrderPdf, invoicePdf, statementPdf, listForUser,
  _nextNumber: nextNumber,
};
