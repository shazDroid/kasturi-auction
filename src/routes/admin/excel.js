// Excel import and export: downloads of auctions, lots, bidders, bids and results; import templates;
// two-step (preview, then commit) imports of lots into an auction and of auctions with their lots.
const express = require('express');
const multer = require('multer');
const db = require('../../db');
const settings = require('../../lib/settings');
const bidding = require('../../lib/bidding');
const billing = require('../../lib/billing');
const rich = require('../../lib/rich');
const xl = require('../../lib/excel');
const { clean, toInt, nl2p, bidderNo, token, fmtDT } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { notFound, label } = require('./helpers');

const router = express.Router();
const STYLES = ['/css/admin-extra.css', '/css/admin-billing.css'];
const UNITS = ['MT', 'KG', 'Nos', 'Lot', 'Ltr', 'Mtr'];
const VIS = ['public', 'restricted'];
const MAX_ROWS = 2000;
const MAX_MONEY = 999999999999;
const SPEC_ROWS = 30;
const r2 = billing.round2;

// Uploads: memory only, 5 MB, .xlsx only. mw.upload accepts images and PDFs only, so this module has its own.
const XLSX_MIME = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed', ''];
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname || '') && XLSX_MIME.includes(file.mimetype || '');
    if (!ok) req.badUpload = file.originalname || 'the file';
    cb(null, ok);
  },
}).single('file');
const runUpload = (req, res) => new Promise((resolve) => xlsxUpload(req, res, (err) => resolve(err || null)));

// ---------------------------------------------------------------------------------------------
// Helpers

const dt = xl.toExcelDate;
const isHtml = (s) => /<\s*(p|br|ul|ol|li|h[1-6]|strong|b|em|i|table|div|span|a)\b[^>]*>/i.test(String(s || ''));
/** Text typed in a sheet -> stored rich text: HTML is sanitised, plain text becomes escaped paragraphs. */
function toRich(s) {
  const t = String(s ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  if (!isHtml(t)) return nl2p(t);
  const clean = rich.sanitize(t);
  if (/^<(p|h[2-4]|ul|ol|table|blockquote|hr)\b/i.test(clean)) return clean;
  // Inline HTML mixed with plain lines: keep the (sanitised) tags and make paragraphs from blank lines.
  return clean.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).map((x) => `<p>${x.replace(/\n/g, '<br>')}</p>`).join('');
}
const plain = (html) => billing.htmlToText(html);
const decimals = (n, d) => Math.abs(n * 10 ** d - Math.round(n * 10 ** d)) < 1e-6;
const fileStamp = () => billing.istDate(new Date());

const LOT_COLS = {
  lot_no: { label: 'lot_no' }, title: { label: 'title', required: true }, description: { label: 'description' },
  quantity: { label: 'quantity', required: true }, unit: { label: 'unit', required: true }, start_price: { label: 'start_price', required: true },
  increment: { label: 'increment' }, reserve_price: { label: 'reserve_price' },
};
const AUCTION_COLS = {
  ref: { required: true }, title: { required: true }, seller: {}, category: {}, location: {}, starts_at: { required: true }, ends_at: { required: true },
  extend_window_min: {}, extend_by_min: {}, stagger_min: {}, visibility: {}, description: {}, inspection: {}, terms: {},
};
/** Header text -> canonical key: "Start price", "start_price" and "START PRICE*" all become start_price. */
const canon = (k) => k.replace(/[\s-]+/g, '_');

/** Classify a sheet's headers. Returns { map: {key: headerKey}, specs: [{key, label}], groups: [{key, name}], unknown: [label] }. */
function classify(headers, known) {
  const out = { map: {}, specs: [], groups: [], unknown: [], dupes: [] };
  for (const h of headers) {
    const spec = h.label.match(/^spec(?:ification)?\s*:\s*(.+)$/i);
    const gp = h.label.match(/^group\s*price\s*:\s*(.+)$/i);
    if (spec) { out.specs.push({ key: h.key, label: spec[1].replace(/\s+/g, ' ').trim().slice(0, 80) }); continue; }
    if (gp) { out.groups.push({ key: h.key, name: gp[1].replace(/\s+/g, ' ').trim() }); continue; }
    const c = canon(h.key);
    if (known[c]) { if (out.map[c]) out.dupes.push(h.label); else out.map[c] = h.key; } else out.unknown.push(h.label);
  }
  return out;
}

/** JSON-safe copy of parsed rows for the session (Dates kept as tagged ISO strings). */
const pack = (rows) => rows.map((r) => ({ n: r.rowNumber, c: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, v instanceof Date ? { d: v.toISOString() } : v])), f: r.noResult || [] }));
const unpack = (rows) => rows.map((r) => ({ rowNumber: r.n, noResult: r.f, cells: Object.fromEntries(Object.entries(r.c).map(([k, v]) => [k, v && typeof v === 'object' && v.d ? new Date(v.d) : v])) }));

/** Read the uploaded workbook. Returns { wb } or { error }. */
async function loadWorkbook(file) {
  if (!file || !file.buffer || !file.buffer.length) return { error: 'Choose an Excel file (.xlsx) to upload.' };
  if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b) return { error: `"${file.originalname}" is not an Excel workbook. Save it from Excel as "Excel Workbook (*.xlsx)" and upload it again. Older .xls files and CSV files are not accepted.` };
  const wb = new xl.ExcelJS.Workbook();
  try { await wb.xlsx.load(file.buffer); } catch (e) {
    return { error: `"${file.originalname}" could not be read as an Excel workbook. Open it in Excel, save it as "Excel Workbook (*.xlsx)" and upload it again.` };
  }
  return { wb };
}

/** Read one sheet with readSheet, also noting formula cells that have no stored result. */
function sheetRows(ws, anchor) {
  const data = xl.readSheet(ws, anchor);
  if (!data) return null;
  for (const r of data.rows) {
    const row = ws.getRow(r.rowNumber);
    r.noResult = data.headers.filter((h) => { const v = row.getCell(h.col).value; return v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v) && (v.result === undefined || v.result === null); }).map((h) => h.key);
  }
  return data;
}

const findSheet = (wb, name) => wb.worksheets.find((w) => w.name.trim().toLowerCase() === name) || null;

// ---------------------------------------------------------------------------------------------
// Validation (shared by preview and commit; commit re-runs it against the database inside the transaction)

/**
 * Validate one lot row. cls: classify() result. ctx: { groups: Map(lower name -> {id, name}), defaultIncrement }.
 * Returns { data, errors: [{col, msg}] }.
 */
function validateLotRow(row, cls, ctx) {
  const errors = [];
  const v = (k) => (cls.map[k] ? row.cells[cls.map[k]] : null);
  const err = (col, msg) => errors.push({ col, msg });
  const formulaHint = (k) => (cls.map[k] && row.noResult.includes(cls.map[k]) ? ' The cell holds a formula with no saved result: open the file in Excel, save it, and upload again.' : '');
  const data = { specs: [], groupPrices: [] };
  const raw = {};
  for (const k of Object.keys(LOT_COLS)) { const x = v(k); raw[k] = x === null || x === undefined ? '' : x instanceof Date ? x.toISOString().slice(0, 16).replace('T', ' ') : String(x); }

  const ln = v('lot_no');
  if (ln === null) data.lot_no = null;
  else {
    const n = xl.parseNumber(ln);
    if (!Number.isInteger(n) || n < 1 || n > 9999) err('lot_no', `"${ln}" is not a lot number. Enter a whole number from 1 to 9999, or leave it blank to number the lot automatically.`);
    else data.lot_no = n;
  }
  const title = v('title');
  data.title = title === null ? '' : String(title).replace(/\s+/g, ' ').trim();
  if (!data.title) err('title', 'The title is empty. Enter what is being sold, for example "HMS 1 and 2 melting scrap".' + formulaHint('title'));
  else if (data.title.length > 200) err('title', `The title is ${data.title.length} characters long. Shorten it to 200 characters or fewer and put the detail in the description.`);
  const desc = v('description');
  data.description = desc === null ? '' : toRich(desc);
  if (String(desc ?? '').length > 20000) err('description', 'The description is longer than 20,000 characters. Shorten it, or upload long details as a PDF document on the auction.');

  const q = v('quantity');
  const qn = xl.parseNumber(q);
  if (q === null) err('quantity', 'The quantity is empty. Enter a number such as 25 or 12.5.' + formulaHint('quantity'));
  else if (!(qn > 0)) err('quantity', `"${q}" is not a quantity. Enter a number above 0, such as 25 or 1,250.5.`);
  else if (!decimals(qn, 3)) err('quantity', `${qn} has more than 3 decimals. Round it to at most 3 decimals.`);
  else if (qn > 99999999999) err('quantity', 'The quantity is too large. Check the number and the unit.');
  else data.quantity = Math.round(qn * 1000) / 1000;

  const u = v('unit');
  const unit = u === null ? null : UNITS.find((x) => x.toLowerCase() === String(u).trim().toLowerCase().replace(/\.$/, ''));
  if (u === null) err('unit', `The unit is empty. Use one of ${UNITS.join(', ')}.`);
  else if (!unit) err('unit', `"${u}" is not a unit we use. Use one of ${UNITS.join(', ')}.`);
  else data.unit = unit;

  const money = (k, name, { required = false, min = 0.01, def = undefined } = {}) => {
    const raw = v(k);
    if (raw === null) {
      if (required) err(k, `The ${name} is empty. Enter rupees, for example 42000.` + formulaHint(k));
      return def;
    }
    const n = xl.parseNumber(raw);
    if (!Number.isFinite(n)) { err(k, `"${raw}" is not an amount. Enter rupees as a number, for example 1,25,000 or 125000.`); return undefined; }
    if (n < min) { err(k, min > 0 ? `The ${name} must be above 0.` : `The ${name} cannot be negative.`); return undefined; }
    if (!decimals(n, 2)) { err(k, `${n} has more than 2 decimals (paise). Round it to 2 decimals.`); return undefined; }
    if (n > MAX_MONEY) { err(k, `The ${name} is too large. Check the number.`); return undefined; }
    return r2(n);
  };
  data.start_price = money('start_price', 'start price', { required: true });
  data.increment = money('increment', 'increment', { def: ctx.defaultIncrement });
  data.reserve_price = money('reserve_price', 'reserve price', { min: 0, def: null });
  if (data.reserve_price === undefined) data.reserve_price = null;

  for (const s of cls.specs) {
    const val = row.cells[s.key];
    if (val === null || val === undefined) continue;
    const text = (val instanceof Date ? new Date(val.getTime()).toISOString().slice(0, 10) : String(val)).replace(/\s+/g, ' ').trim();
    if (text.length > 300) { err(`spec: ${s.label}`, `The value is ${text.length} characters. Keep specifications to 300 characters or move the detail to the description.`); continue; }
    data.specs.push({ label: s.label, value: text });
  }
  if (data.specs.length > SPEC_ROWS) err('spec', `This row has ${data.specs.length} specifications. A lot can have at most ${SPEC_ROWS}.`);

  for (const g of cls.groups) {
    const raw = row.cells[g.key];
    if (raw === null || raw === undefined) continue;
    const grp = ctx.groups.get(g.name.toLowerCase());
    if (!grp) continue; // reported once as a header problem
    const n = xl.parseNumber(raw);
    if (!(n > 0) || !decimals(n, 2) || n > MAX_MONEY) { err(`group price: ${g.name}`, `"${raw}" is not a start price. Enter rupees above 0, or leave the cell empty to use the lot's start price.`); continue; }
    data.groupPrices.push({ group_id: grp.id, name: grp.name, start_price: r2(n) });
  }
  return { data, errors, raw };
}

/** Header checks for a lot sheet. Returns { errors: [string], warnings: [string] }. */
function lotHeaderIssues(cls, ctx, extraRequired = []) {
  const errors = [];
  const warnings = [];
  const missing = [...extraRequired, ...Object.keys(LOT_COLS).filter((k) => LOT_COLS[k].required)].filter((k) => !cls.map[k]);
  if (missing.length) errors.push(`The sheet has no ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}. Add ${missing.length === 1 ? 'it' : 'them'} to the header row, or start from the lot import template.`);
  if (cls.dupes.length) errors.push(`These columns appear twice: ${cls.dupes.join(', ')}. Keep one of each.`);
  const unknownGroups = cls.groups.filter((g) => !ctx.groups.has(g.name.toLowerCase())).map((g) => g.name);
  if (unknownGroups.length) errors.push(`No bidder group is called ${unknownGroups.map((n) => `"${n}"`).join(', ')}. Correct the column name to match a group under Bidders, Bidder groups, or remove the column.`);
  const specLabels = cls.specs.map((s) => s.label.toLowerCase());
  const dupSpec = specLabels.filter((l, i) => specLabels.indexOf(l) !== i);
  if (dupSpec.length) errors.push(`The specification column "${dupSpec[0]}" appears twice. Keep one.`);
  if (cls.unknown.length) warnings.push(`These columns are not used and will be ignored: ${cls.unknown.slice(0, 12).join(', ')}${cls.unknown.length > 12 ? ' and more' : ''}.`);
  return { errors, warnings };
}

async function lotContext(q) {
  const groups = new Map((await q.query('SELECT id, name FROM bidder_groups')).rows.map((g) => [g.name.trim().toLowerCase(), g]));
  return { groups, defaultIncrement: settings.num('default_increment') || 100 };
}

/**
 * Number lots and apply the duplicate rule within one auction. items: [{row, data, errors, status}].
 * existing: Map(lot_no -> {id, bids}). dup: 'skip' | 'update' | 'new'.
 */
function numberLots(items, existing, dup) {
  const used = new Set(existing.keys());
  const seen = new Map();
  for (const it of items) {
    if (it.errors.length || it.data.lot_no === null) continue;
    const n = it.data.lot_no;
    if (seen.has(n)) { it.errors.push({ col: 'lot_no', msg: `Lot number ${n} is already used on row ${seen.get(n)} of this file. Give each lot its own number, or leave lot_no blank.` }); continue; }
    seen.set(n, it.row);
    const ex = existing.get(n);
    if (!ex) { it.status = 'new'; used.add(n); continue; }
    if (dup === 'skip') { it.status = 'skip'; it.note = `Lot ${n} already exists in this auction; this row will be skipped.`; } else if (dup === 'update') {
      if (ex.bids > 0) it.errors.push({ col: 'lot_no', msg: `Lot ${n} already exists and has ${ex.bids} bid${ex.bids === 1 ? '' : 's'}, so it cannot be updated. Remove the row, or choose "Add as a new lot number".` });
      else { it.status = 'update'; it.lotId = ex.id; it.note = `Updates the existing lot ${n}.`; }
    } else { it.renumber = true; }
  }
  let next = Math.max(0, ...used, ...seen.keys());
  for (const it of items) {
    if (it.errors.length || it.status) continue;
    if (it.data.lot_no === null || it.renumber) {
      const from = it.data.lot_no;
      next += 1;
      if (next > 9999) { it.errors.push({ col: 'lot_no', msg: 'There is no free lot number left under 10000.' }); continue; }
      it.data.lot_no = next;
      it.status = 'new';
      it.note = from ? `Lot ${from} already exists; this row becomes lot ${next}.` : `Numbered automatically as lot ${next}.`;
    }
  }
}

/** Full validation of a lots import. q: db.pool or a transaction client. */
async function validateLotsImport(q, payload) {
  const a = (await q.query(`SELECT id, title, status, starts_at, ends_at, now() >= ends_at AS over FROM auctions WHERE id = $1`, [payload.auctionId])).rows[0];
  const res = { auction: a, fatal: [], warnings: [], items: [] };
  if (!a) { res.fatal.push('The auction no longer exists.'); return res; }
  if (a.status === 'cancelled') res.fatal.push('This auction is cancelled. Lots cannot be imported into it.');
  if (a.over) res.fatal.push(`The bidding window of this auction ended on ${fmtDT(a.ends_at)} IST. Lots cannot be added after an auction has closed; create a new auction instead.`);
  const ctx = await lotContext(q);
  const cls = classify(payload.headers, LOT_COLS);
  const h = lotHeaderIssues(cls, ctx);
  res.fatal.push(...h.errors);
  res.warnings.push(...h.warnings);
  if (res.fatal.length) return res;
  const existing = new Map((await q.query(
    `SELECT l.lot_no, l.id, (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id) AS bids FROM lots l WHERE l.auction_id = $1`, [a.id]
  )).rows.map((r) => [r.lot_no, r]));
  res.items = unpack(payload.rows).map((row) => ({ row: row.rowNumber, ...validateLotRow(row, cls, ctx), status: null }));
  // Columns missing from the sheet leave those fields of an updated lot unchanged.
  res.keep = { description: !cls.map.description, specs: !cls.specs.length, increment: !cls.map.increment, reserve_price: !cls.map.reserve_price };
  numberLots(res.items, existing, payload.options.dup);
  for (const it of res.items) if (it.errors.length) it.status = 'error';
  return res;
}

function validateAuctionRow(row, cls, sellers, createSellers) {
  const errors = [];
  const v = (k) => (cls.map[k] ? row.cells[cls.map[k]] : null);
  const err = (col, msg) => errors.push({ col, msg });
  const data = {};
  data.ref = v('ref') === null ? '' : String(v('ref')).trim();
  if (!data.ref) err('ref', 'The ref is empty. Give each auction a short reference such as A1, and use the same ref in the auction_ref column of the Lots sheet.');
  else if (data.ref.length > 50) err('ref', 'The ref is too long. Use 50 characters or fewer.');
  data.title = v('title') === null ? '' : String(v('title')).replace(/\s+/g, ' ').trim();
  if (!data.title) err('title', 'The title is empty. Enter a title, for example "HMS 1 and 2 scrap, Pune plant".');
  else if (data.title.length > 200) err('title', 'The title is longer than 200 characters. Shorten it.');
  const sellerName = v('seller') === null ? '' : String(v('seller')).replace(/\s+/g, ' ').trim();
  data.sellerName = sellerName;
  if (sellerName) {
    const s = sellers.get(sellerName.toLowerCase());
    if (s) data.seller_id = s.id;
    else if (createSellers) { data.seller_id = null; data.newSeller = sellerName.slice(0, 200); } else err('seller', `No seller is called "${sellerName}". Check the spelling against Sellers, tick "Create sellers that do not exist yet", or leave the cell empty.`);
  } else data.seller_id = null;
  data.category = String(v('category') ?? '').trim().slice(0, 100);
  data.location = String(v('location') ?? '').trim().slice(0, 200);
  const dateCol = (k, name) => {
    const raw = v(k);
    if (raw === null) { err(k, `The ${name} is empty. Enter it as an Excel date and time or as text like 15-01-2027 11:00 (IST).`); return null; }
    const d = xl.parseDateIST(raw);
    if (!d) err(k, `"${raw instanceof Date ? raw.toISOString() : raw}" is not a date and time. Use an Excel date or text like 15-01-2027 11:00 (day-month-year, 24-hour, IST).`);
    return d;
  };
  data.starts_at = dateCol('starts_at', 'start date and time');
  data.ends_at = dateCol('ends_at', 'closing date and time');
  if (data.starts_at && data.ends_at && data.ends_at <= data.starts_at) err('ends_at', 'The closing time is not after the start time. Correct one of them.');
  if (data.ends_at && data.ends_at <= new Date()) err('ends_at', 'The closing time is in the past. Enter a future closing time.');
  const mins = (k, def, max) => {
    const raw = v(k);
    if (raw === null) return def;
    const n = xl.parseNumber(raw);
    if (!Number.isInteger(n) || n < 0 || n > max) { err(k, `"${raw}" is not valid. Enter a whole number of minutes from 0 to ${max}.`); return def; }
    return n;
  };
  data.extend_window_min = mins('extend_window_min', settings.num('default_extend_window_min'), 120);
  data.extend_by_min = mins('extend_by_min', settings.num('default_extend_by_min'), 120);
  data.stagger_min = mins('stagger_min', 0, 240);
  const vis = v('visibility') === null ? 'public' : String(v('visibility')).trim().toLowerCase();
  if (!VIS.includes(vis)) err('visibility', `"${v('visibility')}" is not a visibility. Use public or restricted.`);
  data.visibility = VIS.includes(vis) ? vis : 'public';
  for (const k of ['description', 'inspection', 'terms']) {
    const raw = v(k);
    if (String(raw ?? '').length > 20000) err(k, `The ${k} is longer than 20,000 characters. Shorten it or attach it as a PDF document later.`);
    data[k] = toRich(raw);
  }
  return { data, errors };
}

async function validateAuctionsImport(q, payload) {
  const res = { fatal: [], warnings: [], auctions: [], lots: [] };
  const aCls = classify(payload.auctions.headers, AUCTION_COLS);
  const missing = Object.keys(AUCTION_COLS).filter((k) => AUCTION_COLS[k].required && !aCls.map[k]);
  if (missing.length) res.fatal.push(`The Auctions sheet has no ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}. Add ${missing.length === 1 ? 'it' : 'them'} to the header row, or start from the auction import template.`);
  if (aCls.dupes.length) res.fatal.push(`These columns appear twice on the Auctions sheet: ${aCls.dupes.join(', ')}.`);
  if (aCls.unknown.length) res.warnings.push(`Columns on the Auctions sheet that are not used and will be ignored: ${aCls.unknown.slice(0, 12).join(', ')}.`);
  const ctx = await lotContext(q);
  const lCls = classify(payload.lots.headers, { ...LOT_COLS, auction_ref: {} });
  const lh = lotHeaderIssues(lCls, ctx, ['auction_ref']);
  res.fatal.push(...lh.errors.map((e) => 'Lots sheet: ' + e));
  res.warnings.push(...lh.warnings.map((e) => 'Lots sheet: ' + e));
  if (res.fatal.length) return res;
  const sellers = new Map((await q.query('SELECT id, name FROM sellers')).rows.map((s) => [s.name.trim().replace(/\s+/g, ' ').toLowerCase(), s]));
  const refs = new Map();
  for (const row of unpack(payload.auctions.rows)) {
    const it = { row: row.rowNumber, ...validateAuctionRow(row, aCls, sellers, payload.options.createSellers), lots: [] };
    if (it.data.ref) {
      const key = it.data.ref.toLowerCase();
      if (refs.has(key)) it.errors.push({ col: 'ref', msg: `The ref "${it.data.ref}" is already used on row ${refs.get(key).row}. Give each auction its own ref.` });
      else refs.set(key, it);
    }
    it.status = it.errors.length ? 'error' : 'new';
    res.auctions.push(it);
  }
  for (const row of unpack(payload.lots.rows)) {
    const it = { row: row.rowNumber, ...validateLotRow(row, lCls, ctx), status: null };
    const ref = row.cells[lCls.map.auction_ref];
    const parent = ref === null || ref === undefined ? null : refs.get(String(ref).trim().toLowerCase());
    it.ref = ref === null || ref === undefined ? '' : String(ref).trim();
    if (!it.ref) it.errors.push({ col: 'auction_ref', msg: 'The auction_ref is empty. Enter the ref of the auction on the Auctions sheet that this lot belongs to.' });
    else if (!parent) it.errors.push({ col: 'auction_ref', msg: `No auction on the Auctions sheet has the ref "${it.ref}". Check the spelling.` });
    else { it.parent = parent; parent.lots.push(it); }
    res.lots.push(it);
  }
  for (const a of res.auctions) numberLots(a.lots, new Map(), 'new');
  for (const it of res.lots) {
    if (!it.errors.length && it.parent && it.parent.status === 'error') { it.status = 'skip'; it.note = `Skipped because auction row ${it.parent.row} (ref ${it.ref}) has errors.`; }
    if (it.errors.length) it.status = 'error';
  }
  for (const a of res.auctions) {
    if (a.status !== 'error' && !a.lots.some((l) => l.status === 'new')) a.note = 'No valid lots for this auction; it is created without lots.';
    if (a.status !== 'error' && a.data.visibility === 'restricted') a.note = [a.note, 'Restricted: choose its groups or invite bidders before publishing.'].filter(Boolean).join(' ');
    if (a.data.newSeller) a.note = [a.note, `Seller "${a.data.newSeller}" will be created.`].filter(Boolean).join(' ');
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Main page

const importableAuctions = () => db.many(
  `SELECT a.id, a.title, a.starts_at, a.ends_at, a.status, ${bidding.PHASE_SQL} AS phase,
          (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id) AS lots
     FROM auctions a WHERE a.status <> 'cancelled' AND a.ends_at > now() ORDER BY a.starts_at LIMIT 300`
);

router.get('/excel', wrap(async (req, res) => {
  const auctions = await db.many(`SELECT a.id, a.title, a.starts_at, a.status FROM auctions a ORDER BY a.starts_at DESC LIMIT 500`);
  res.adminPage('admin/excel', {
    title: 'Import and export', styles: STYLES, auctions, importable: await importableAuctions(),
    pending: req.session.xlImport ? { kind: req.session.xlImport.kind, file: req.session.xlImport.file } : null,
    preset: toInt(req.query.auction, 0),
  });
}));

// ---------------------------------------------------------------------------------------------
// Exports

const RICH_FIELDS = ['description', 'inspection', 'terms'];

router.get('/excel/export/auctions.xlsx', wrap(async (req, res) => {
  const rows = await db.many(
    `SELECT a.*, s.name AS seller, ${bidding.PHASE_SQL} AS phase,
            (SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM auction_groups ag JOIN bidder_groups g ON g.id = ag.group_id WHERE ag.auction_id = a.id) AS groups,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id) AS lots
       FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id ORDER BY a.starts_at DESC, a.id DESC`
  );
  for (const r of rows) {
    Object.assign(r, { ref: r.id, starts: dt(r.starts_at), ends: dt(r.ends_at), created: dt(r.created_at), phase_label: label('phase', r.phase), highest: r.show_highest_bid ? 'Yes' : 'No', auto: r.auto_award ? 'Yes' : 'No' });
    for (const k of RICH_FIELDS) { r[k + '_text'] = plain(r[k]); r[k + '_html'] = r[k]; }
  }
  const wb = xl.workbook();
  xl.addTable(wb, 'Auctions', {
    columns: [
      { header: 'ref', key: 'ref', type: 'int' }, { header: 'title', key: 'title', width: 40 }, { header: 'seller', key: 'seller', width: 28 },
      { header: 'category', key: 'category' }, { header: 'location', key: 'location', width: 28 },
      { header: 'starts_at', key: 'starts', type: 'datetime' }, { header: 'ends_at', key: 'ends', type: 'datetime' },
      { header: 'extend_window_min', key: 'extend_window_min', type: 'int' }, { header: 'extend_by_min', key: 'extend_by_min', type: 'int' }, { header: 'stagger_min', key: 'stagger_min', type: 'int' },
      { header: 'visibility', key: 'visibility' }, { header: 'groups', key: 'groups' }, { header: 'status', key: 'status' }, { header: 'phase', key: 'phase_label' },
      { header: 'show_highest_bid', key: 'highest' }, { header: 'auto_award', key: 'auto' }, { header: 'lots', key: 'lots', type: 'int' },
      { header: 'description', key: 'description_text', width: 50 }, { header: 'inspection', key: 'inspection_text', width: 50 }, { header: 'terms', key: 'terms_text', width: 50 },
      { header: 'description_html', key: 'description_html', width: 30 }, { header: 'inspection_html', key: 'inspection_html', width: 30 }, { header: 'terms_html', key: 'terms_html', width: 30 },
      { header: 'created_at', key: 'created', type: 'datetime' },
    ],
    rows,
  });
  audit(req, 'excel.export_auctions', `${rows.length} rows`);
  await xl.send(res, wb, `auctions-${fileStamp()}.xlsx`);
}));

router.get('/excel/export/lots.xlsx', wrap(async (req, res) => {
  const auctionId = toInt(req.query.auction, 0) || null;
  if (auctionId && !(await db.one('SELECT id FROM auctions WHERE id = $1', [auctionId]))) return notFound(res, 'This auction');
  const rows = await db.many(
    `SELECT l.*, a.title AS auction_title, (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled) AS bids
       FROM lots l JOIN auctions a ON a.id = l.auction_id WHERE ($1::int IS NULL OR a.id = $1) ORDER BY a.starts_at DESC, a.id, l.lot_no`, [auctionId]
  );
  const gp = await db.many(
    `SELECT gp.lot_id, g.name, gp.start_price FROM lot_group_prices gp JOIN bidder_groups g ON g.id = gp.group_id JOIN lots l ON l.id = gp.lot_id
      WHERE ($1::int IS NULL OR l.auction_id = $1)`, [auctionId]
  );
  const specLabels = [];
  for (const r of rows) for (const s of r.specs || []) if (s && s.label && !specLabels.includes(s.label)) specLabels.push(s.label);
  const groupNames = [...new Set(gp.map((g) => g.name))].sort();
  for (const r of rows) {
    Object.assign(r, { auction_ref: r.auction_id, description_text: plain(r.description), description_html: r.description, ends: dt(r.ends_at), result_label: r.status === 'open' ? 'Open' : label('result', r.result) });
    for (const s of r.specs || []) r['spec:' + s.label] = s.value;
  }
  for (const g of gp) { const r = rows.find((x) => x.id === g.lot_id); if (r) r['gp:' + g.name] = g.start_price; }
  const wb = xl.workbook();
  xl.addTable(wb, 'Lots', {
    columns: [
      { header: 'auction_ref', key: 'auction_ref', type: 'int' }, { header: 'auction', key: 'auction_title', width: 34 },
      { header: 'lot_no', key: 'lot_no', type: 'int' }, { header: 'title', key: 'title', width: 36 }, { header: 'description', key: 'description_text', width: 50 },
      { header: 'quantity', key: 'quantity', type: 'num' }, { header: 'unit', key: 'unit' }, { header: 'start_price', key: 'start_price', type: 'money' },
      { header: 'increment', key: 'increment', type: 'money' }, { header: 'reserve_price', key: 'reserve_price', type: 'money' },
      ...specLabels.map((l) => ({ header: `spec: ${l}`, key: 'spec:' + l })),
      ...groupNames.map((n) => ({ header: `group price: ${n}`, key: 'gp:' + n, type: 'money' })),
      { header: 'ends_at', key: 'ends', type: 'datetime' }, { header: 'result', key: 'result_label' }, { header: 'bids', key: 'bids', type: 'int' },
      { header: 'description_html', key: 'description_html', width: 30 },
    ],
    rows,
  });
  audit(req, 'excel.export_lots', `${auctionId ? 'auction #' + auctionId : 'all auctions'}: ${rows.length} rows`);
  await xl.send(res, wb, `lots-${auctionId ? 'auction-' + auctionId : 'all'}-${fileStamp()}.xlsx`);
}));

router.get('/excel/export/bidders.xlsx', wrap(async (req, res) => {
  const rows = await db.many(
    `SELECT u.*, g.name AS group_name, (SELECT count(*)::int FROM bids b WHERE b.user_id = u.id AND NOT b.cancelled) AS bids
       FROM users u LEFT JOIN bidder_groups g ON g.id = u.group_id ORDER BY u.id`
  );
  for (const r of rows) {
    Object.assign(r, { no: bidderNo(r.id), kyc: label('kyc', r.kyc_status), verified: r.email_verified ? 'Yes' : 'No', blocked_l: r.blocked ? 'Yes' : 'No',
      fee_until: r.fee_paid_until && new Date(r.fee_paid_until).getFullYear() > 2900 ? null : dt(r.fee_paid_until), created: dt(r.created_at), last: dt(r.last_login_at) });
  }
  const wb = xl.workbook();
  xl.addTable(wb, 'Bidders', {
    columns: [
      { header: 'Bidder no', key: 'no' }, { header: 'Name', key: 'name' }, { header: 'Company', key: 'company_name', width: 32 }, { header: 'Email', key: 'email' },
      { header: 'Phone', key: 'phone' }, { header: 'Business type', key: 'business_type' }, { header: 'GSTIN', key: 'gstin' }, { header: 'PAN', key: 'pan' },
      { header: 'Address', key: 'address', width: 40 }, { header: 'City', key: 'city' }, { header: 'State', key: 'state' }, { header: 'Pincode', key: 'pincode' },
      { header: 'Group', key: 'group_name' }, { header: 'Documents', key: 'kyc' }, { header: 'Email verified', key: 'verified' }, { header: 'Blocked', key: 'blocked_l' },
      { header: 'Fee paid until (IST)', key: 'fee_until', type: 'datetime' }, { header: 'Bids', key: 'bids', type: 'int' },
      { header: 'Registered (IST)', key: 'created', type: 'datetime' }, { header: 'Last sign in (IST)', key: 'last', type: 'datetime' },
    ],
    rows,
  });
  audit(req, 'excel.export_bidders', `${rows.length} rows`);
  await xl.send(res, wb, `bidders-${fileStamp()}.xlsx`);
}));

router.get('/excel/export/bids.xlsx', wrap(async (req, res) => {
  const a = await db.one('SELECT id, title FROM auctions WHERE id = $1', [toInt(req.query.auction, 0)]);
  if (!a) { req.flash('error', 'Choose an auction to download its bids.'); return res.redirect('/admin/excel'); }
  const rows = await db.many(
    `SELECT b.*, l.lot_no, l.title AS lot_title, u.name, u.company_name FROM bids b JOIN lots l ON l.id = b.lot_id JOIN users u ON u.id = b.user_id
      WHERE l.auction_id = $1 ORDER BY b.created_at, b.id`, [a.id]
  );
  for (const r of rows) Object.assign(r, { at: dt(r.created_at), no: bidderNo(r.user_id), auto_l: r.auto ? 'Auto' : 'Manual', state: r.cancelled ? 'Cancelled' : 'Valid' });
  const wb = xl.workbook();
  xl.addTable(wb, 'Bids', {
    title: `Bids: ${a.title}`, filters: [`Auction #${a.id}`],
    columns: [
      { header: 'Time (IST)', key: 'at', type: 'datetime' }, { header: 'Lot no', key: 'lot_no', type: 'int' }, { header: 'Lot', key: 'lot_title', width: 34 },
      { header: 'Bidder no', key: 'no' }, { header: 'Bidder', key: 'name' }, { header: 'Company', key: 'company_name', width: 30 },
      { header: 'Amount (INR)', key: 'amount', type: 'money' }, { header: 'Placed by', key: 'auto_l' }, { header: 'Status', key: 'state' },
      { header: 'Cancel note', key: 'cancel_note' }, { header: 'IP address', key: 'ip' },
    ],
    rows,
  });
  audit(req, 'excel.export_bids', `auction #${a.id}: ${rows.length} rows`);
  await xl.send(res, wb, `bids-auction-${a.id}-${fileStamp()}.xlsx`);
}));

router.get('/excel/export/results.xlsx', wrap(async (req, res) => {
  const a = await db.one('SELECT id, title FROM auctions WHERE id = $1', [toInt(req.query.auction, 0)]);
  if (!a) { req.flash('error', 'Choose an auction to download its results.'); return res.redirect('/admin/excel'); }
  const rows = await db.many(
    `SELECT l.*, w.amount, w.user_id, u.name, u.company_name, u.phone, u.email, so.number AS so_number,
            COALESCE(l.commission_percent, g.commission_percent, $2::numeric) AS pct,
            (SELECT count(*)::int FROM bids b WHERE b.lot_id = l.id AND NOT b.cancelled) AS bids
       FROM lots l LEFT JOIN bids w ON w.id = l.winning_bid_id LEFT JOIN users u ON u.id = w.user_id
       LEFT JOIN bidder_groups g ON g.id = u.group_id LEFT JOIN sale_orders so ON so.lot_id = l.id
      WHERE l.auction_id = $1 ORDER BY l.lot_no`, [a.id, settings.num('default_commission_percent')]
  );
  for (const r of rows) {
    const decided = r.result === 'awarded' || r.result === 'pending';
    Object.assign(r, {
      result_l: r.status === 'open' ? 'Open' : label('result', r.result), value: r.amount !== null ? r2(r.amount * r.quantity) : null,
      met: r.reserve_price === null ? 'No reserve' : r.amount === null ? '' : r.amount >= r.reserve_price ? 'Yes' : 'No',
      no: r.user_id ? bidderNo(r.user_id) : '', closed: r.status === 'closed' ? dt(r.ends_at) : null,
      pct_v: decided ? r.pct : null, comm: decided && r.amount !== null ? r2(r2(r.amount * r.quantity) * r.pct / 100) : null,
      paid: dt(r.buyer_paid_at), lifted: dt(r.lifted_at),
    });
  }
  const wb = xl.workbook();
  xl.addTable(wb, 'Results', {
    title: `Results: ${a.title}`, filters: [`Auction #${a.id}`],
    columns: [
      { header: 'Lot no', key: 'lot_no', type: 'int' }, { header: 'Lot', key: 'title', width: 34 }, { header: 'Quantity', key: 'quantity', type: 'num' }, { header: 'Unit', key: 'unit' },
      { header: 'Result', key: 'result_l' }, { header: 'Bids', key: 'bids', type: 'int' }, { header: 'Highest bid (INR)', key: 'amount', type: 'money' },
      { header: 'Value (INR)', key: 'value', type: 'money' }, { header: 'Reserve (INR)', key: 'reserve_price', type: 'money' }, { header: 'Reserve met', key: 'met' },
      { header: 'Bidder no', key: 'no' }, { header: 'Bidder', key: 'name' }, { header: 'Company', key: 'company_name', width: 30 }, { header: 'Phone', key: 'phone' }, { header: 'Email', key: 'email' },
      { header: 'Commission %', key: 'pct_v', type: 'pct' }, { header: 'Commission (INR)', key: 'comm', type: 'money' }, { header: 'Sale order', key: 'so_number' },
      { header: 'Closed (IST)', key: 'closed', type: 'datetime' }, { header: 'Buyer paid', key: 'paid', type: 'date' }, { header: 'Lifted', key: 'lifted', type: 'date' },
      { header: 'Decision note', key: 'result_note', width: 30 },
    ],
    rows,
    totals: { title: 'Total', value: r2(rows.filter((r) => r.result === 'awarded').reduce((s, r) => s + (r.value || 0), 0)), comm: r2(rows.filter((r) => r.result === 'awarded').reduce((s, r) => s + (r.comm || 0), 0)) },
    note: 'Totals count awarded lots only.',
  });
  audit(req, 'excel.export_results', `auction #${a.id}`);
  await xl.send(res, wb, `results-auction-${a.id}-${fileStamp()}.xlsx`);
}));

// ---------------------------------------------------------------------------------------------
// Templates

const LOT_HELP = [
  ['lot_no', 'No', 'Whole number 1 to 9999', 'Lot number in the auction. Leave blank to number lots automatically after the last lot.', '1'],
  ['title', 'Yes', 'Text, up to 200 characters', 'What is being sold.', 'HMS 1 and 2 melting scrap'],
  ['description', 'No', 'Plain text (blank lines start a new paragraph)', 'Details shown on the lot page.', 'Cut pieces of structural steel, free from rubber and oil.'],
  ['quantity', 'Yes', 'Number above 0, up to 3 decimals', 'Estimated quantity. Numbers stored as text such as "1,250.5" are accepted.', '120'],
  ['unit', 'Yes', UNITS.join(', '), 'Unit of the quantity and of the rate bidders quote.', 'MT'],
  ['start_price', 'Yes', 'Rupees above 0, up to 2 decimals', 'Opening rate per unit.', '32000'],
  ['increment', 'No', 'Rupees above 0', `Minimum raise per bid. Blank uses the default from Settings (${settings.num('default_increment') || 100}).`, '100'],
  ['reserve_price', 'No', 'Rupees, 0 or more', 'Lowest rate the seller accepts. Bidders do not see it. Blank means no reserve.', '33500'],
  ['spec: <Label>', 'No', 'Text, up to 300 characters', 'Any number of columns named "spec: " followed by the label become the specification table, for example "spec: Grade". Empty cells are skipped.', 'spec: Grade = EN8'],
  ['group price: <Group name>', 'No', 'Rupees above 0', 'Opening rate for a bidder group, for example "group price: Recyclers". The name must match a group under Bidder groups. Empty means the lot\'s start price.', '31000'],
];
const AUCTION_HELP = [
  ['ref', 'Yes', 'Short text, unique in the file', 'Your reference for the auction. The Lots sheet uses it in auction_ref. It is not saved.', 'A1'],
  ['title', 'Yes', 'Text, up to 200 characters', 'Auction title shown to bidders.', 'Melting scrap, Pune plant, January'],
  ['seller', 'No', 'Name of an existing seller', 'Matched by name, ignoring capitals. Tick "Create sellers that do not exist yet" to add new sellers.', 'Shivalik Forgings Pvt Ltd'],
  ['category', 'No', 'Text', 'Category, for example Ferrous scrap.', 'Ferrous scrap'],
  ['location', 'No', 'Text', 'Where the material is.', 'Chakan, Pune'],
  ['starts_at', 'Yes', 'Excel date and time, or text DD-MM-YYYY HH:mm', 'Bidding starts (IST, 24-hour clock).', '15-01-2027 11:00'],
  ['ends_at', 'Yes', 'Excel date and time, or text DD-MM-YYYY HH:mm', 'Bidding closes (IST). Must be after starts_at and in the future.', '15-01-2027 13:00'],
  ['extend_window_min', 'No', 'Whole number 0 to 120', `A bid in the last N minutes extends the lot. Blank uses Settings (${settings.num('default_extend_window_min')}).`, '3'],
  ['extend_by_min', 'No', 'Whole number 0 to 120', `How long each extension is. Blank uses Settings (${settings.num('default_extend_by_min')}).`, '3'],
  ['stagger_min', 'No', 'Whole number 0 to 240', 'Lot N closes stagger_min x (N-1) minutes after ends_at. Blank means 0.', '2'],
  ['visibility', 'No', 'public, restricted', 'Restricted auctions are seen only by chosen groups or invited bidders. Blank means public.', 'public'],
  ['description', 'No', 'Plain text', 'About the auction.', ''],
  ['inspection', 'No', 'Plain text', 'Inspection arrangements.', ''],
  ['terms', 'No', 'Plain text', 'Payment and lifting terms.', ''],
];

function instructionsSheet(wb, title, intro, sections) {
  const ws = wb.addWorksheet('Instructions');
  ws.getColumn(1).width = 26; ws.getColumn(2).width = 10; ws.getColumn(3).width = 36; ws.getColumn(4).width = 70; ws.getColumn(5).width = 30;
  ws.getCell('A1').value = title; ws.getCell('A1').font = { bold: true, size: 14 };
  let r = 2;
  for (const line of intro) { ws.getCell(r, 1).value = line; ws.mergeCells(r, 1, r, 5); ws.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' }; ws.getRow(r).height = 30; r++; }
  for (const [name, rows] of sections) {
    r++;
    ws.getCell(r, 1).value = name; ws.getCell(r, 1).font = { bold: true, size: 12 }; r++;
    ['Column', 'Required', 'Allowed values', 'Meaning', 'Example'].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6EBF1' } }; });
    r++;
    for (const row of rows) { row.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = v; c.alignment = { wrapText: true, vertical: 'top' }; }); r++; }
  }
}

async function lotTemplateSheet(wb, name, withRef) {
  const groups = await db.many('SELECT name FROM bidder_groups ORDER BY lower(name) LIMIT 2');
  const cols = [...(withRef ? ['auction_ref'] : []), 'lot_no', 'title', 'description', 'quantity', 'unit', 'start_price', 'increment', 'reserve_price', 'spec: Grade', 'spec: Form', ...groups.map((g) => `group price: ${g.name}`)];
  const ex = [
    { auction_ref: 'A1', lot_no: 1, title: 'HMS 1 and 2 melting scrap', description: 'Cut pieces of structural steel, free from rubber and oil.', quantity: 120, unit: 'MT', start_price: 32000, increment: 100, reserve_price: 33500, 'spec: Grade': 'HMS 1 and 2 (80:20)', 'spec: Form': 'Cut to 1.5 m' },
    { auction_ref: 'A1', lot_no: 2, title: 'CRC sheet cuttings, bundled', description: 'Press shop offcuts in bundles of about 1 MT.', quantity: 45.5, unit: 'MT', start_price: 38500, increment: 200, reserve_price: null, 'spec: Grade': 'CRCA', 'spec: Form': 'Bundles' },
  ];
  if (groups[0]) ex[0][`group price: ${groups[0].name}`] = 31000;
  const ws = wb.addWorksheet(name);
  cols.forEach((c, i) => {
    const cell = ws.getCell(1, i + 1);
    const req = ['auction_ref', 'title', 'quantity', 'unit', 'start_price'].includes(c);
    cell.value = c; cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: req ? 'FFD7E0EA' : 'FFE6EBF1' } };
    ws.getColumn(i + 1).width = Math.max(12, Math.min(44, c.length + 4, c === 'title' || c === 'description' ? 44 : 99));
  });
  ex.forEach((row, k) => cols.forEach((c, i) => {
    const v = row[c];
    const cell = ws.getCell(k + 2, i + 1);
    cell.value = v === undefined ? null : v;
    if (['start_price', 'increment', 'reserve_price'].includes(c) || c.startsWith('group price:')) cell.numFmt = '#,##0.00';
  }));
  const unitCol = ws.getColumn(cols.indexOf('unit') + 1).letter;
  ws.dataValidations.add(`${unitCol}2:${unitCol}${MAX_ROWS + 1}`, {
    type: 'list', allowBlank: true, formulae: [`"${UNITS.join(',')}"`], showErrorMessage: true, errorStyle: 'error', errorTitle: 'Unit', error: `Choose one of ${UNITS.join(', ')}.`,
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

router.get('/excel/template/lots.xlsx', wrap(async (req, res) => {
  const wb = xl.workbook();
  instructionsSheet(wb, 'Lot import template', [
    'Fill the Lots sheet, one row per lot, keeping the header row as it is. Delete the two example rows first. Columns marked Yes are required. Up to 2,000 lots per file.',
    'Upload the file under Admin, Import and export, Import lots into an auction. You will see a preview with any problems before anything is saved.',
  ], [['Lots sheet', LOT_HELP]]);
  await lotTemplateSheet(wb, 'Lots', false);
  wb.views = [{ activeTab: 1 }];
  await xl.send(res, wb, 'lot-import-template.xlsx');
}));

router.get('/excel/template/auctions.xlsx', wrap(async (req, res) => {
  const wb = xl.workbook();
  instructionsSheet(wb, 'Auction and lots import template', [
    'Fill the Auctions sheet with one row per auction and the Lots sheet with one row per lot. Each lot names its auction in auction_ref. Delete the example rows first.',
    'Imported auctions are always created as drafts. Check them, add photos and documents, then publish. Times are IST.',
  ], [['Auctions sheet', AUCTION_HELP], ['Lots sheet', [['auction_ref', 'Yes', 'A ref from the Auctions sheet', 'The auction this lot belongs to.', 'A1'], ...LOT_HELP]]]);
  const ws = wb.addWorksheet('Auctions');
  const cols = Object.keys(AUCTION_COLS);
  cols.forEach((c, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = c; cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AUCTION_COLS[c].required ? 'FFD7E0EA' : 'FFE6EBF1' } };
    ws.getColumn(i + 1).width = ['title', 'description', 'inspection', 'terms'].includes(c) ? 40 : c.endsWith('_at') ? 18 : Math.max(12, c.length + 3);
  });
  const t0 = new Date(Date.now() + 14 * 86400000);
  const day = billing.istDate(t0);
  const at = (h, m) => new Date(`${day}T${pad2(h)}:${pad2(m)}:00Z`); // IST wall clock as an Excel date
  const seller = await db.one('SELECT name FROM sellers ORDER BY id LIMIT 1');
  const ex = [
    { ref: 'A1', title: 'Melting scrap, Pune plant', seller: seller ? seller.name : '', category: 'Ferrous scrap', location: 'Chakan, Pune', starts_at: at(11, 0), ends_at: at(13, 0), extend_window_min: 3, extend_by_min: 3, stagger_min: 2, visibility: 'public', description: 'Monthly sale of melting scrap from the press shop.', inspection: 'Inspection on working days, 10 am to 4 pm. Call the stores manager first.', terms: '25% within 3 working days of the award, balance before lifting.' },
    { ref: 'A2', title: 'Surplus machinery, Nashik', seller: '', category: 'Machinery', location: 'Satpur, Nashik', starts_at: `${day.split('-').reverse().join('-')} 15:00`, ends_at: `${day.split('-').reverse().join('-')} 17:30`, visibility: 'restricted', description: '', inspection: '', terms: '' },
  ];
  ex.forEach((row, k) => cols.forEach((c, i) => {
    const cell = ws.getCell(k + 2, i + 1);
    cell.value = row[c] === undefined ? null : row[c];
    if (row[c] instanceof Date) cell.numFmt = 'dd-mm-yyyy hh:mm';
  }));
  const visCol = ws.getColumn(cols.indexOf('visibility') + 1).letter;
  ws.dataValidations.add(`${visCol}2:${visCol}${MAX_ROWS + 1}`, { type: 'list', allowBlank: true, formulae: ['"public,restricted"'], showErrorMessage: true, errorTitle: 'Visibility', error: 'Choose public or restricted.' });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const lws = await lotTemplateSheet(wb, 'Lots', true);
  lws.getCell(3, 1).value = 'A2';
  wb.views = [{ activeTab: 1 }];
  await xl.send(res, wb, 'auction-import-template.xlsx');
}));
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------------------------
// Imports: upload -> session -> review (GET) -> commit

function readOptions(body) {
  return {
    invalid: body.invalid === 'refuse' ? 'refuse' : 'skip',
    dup: ['skip', 'update', 'new'].includes(body.dup) ? body.dup : 'skip',
    createSellers: body.create_sellers === '1',
  };
}

router.post('/excel/import/lots', wrap(async (req, res) => {
  const err = await runUpload(req, res);
  const back = `/admin/excel${req.query.auction ? '?auction=' + toInt(req.query.auction, 0) : ''}`;
  if (err) { req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB. Split it into smaller files of up to 2,000 lots.' : 'The upload failed. Try again.'); return res.redirect(back); }
  if (req.badUpload) { req.flash('error', `"${req.badUpload}" is not an .xlsx file. Save it from Excel as "Excel Workbook (*.xlsx)" and upload it again.`); return res.redirect(back); }
  const auctionId = toInt(req.body.auction_id, 0);
  const a = await db.one('SELECT id, title FROM auctions WHERE id = $1', [auctionId]);
  if (!a) { req.flash('error', 'Choose the auction to import the lots into.'); return res.redirect(back); }
  const { wb, error } = await loadWorkbook(req.file);
  if (error) { req.flash('error', error); return res.redirect(back); }
  const nonEmpty = wb.worksheets.filter((w) => w.actualRowCount > 0);
  if (!nonEmpty.length) { req.flash('error', 'The workbook is empty. Fill in the Lots sheet (download the template for the layout) and upload it again.'); return res.redirect(back); }
  const named = findSheet(wb, 'lots');
  const ws = (named && named.actualRowCount > 0 ? named : null) || nonEmpty.find((w) => xl.readSheet(w, 'title')) || named || nonEmpty[0];
  if (ws.actualRowCount === 0) { req.flash('error', `The sheet "${ws.name}" is empty. Fill it in and upload the file again.`); return res.redirect(back); }
  const data = sheetRows(ws, 'title');
  if (!data) { req.flash('error', `The sheet "${ws.name}" has no header row with a "title" column in its first 10 rows. Required columns: title, quantity, unit, start_price. Start from the lot import template.`); return res.redirect(back); }
  if (!data.rows.length) { req.flash('error', `The sheet "${ws.name}" has a header row but no lots under it.`); return res.redirect(back); }
  if (data.rows.length > MAX_ROWS) { req.flash('error', `The sheet has ${data.rows.length.toLocaleString('en-IN')} lots. Import at most ${MAX_ROWS.toLocaleString('en-IN')} at a time: split the file and upload each part.`); return res.redirect(back); }
  req.session.xlImport = {
    id: token(8), kind: 'lots', auctionId: a.id, file: clean(req.file.originalname, 120), sheet: ws.name, options: readOptions(req.body),
    headers: data.headers.map((h) => ({ key: h.key, label: h.label })), rows: pack(data.rows),
  };
  audit(req, 'excel.import_preview', `lots for auction #${a.id}: ${req.file.originalname}, ${data.rows.length} rows`);
  res.redirect('/admin/excel/import/review');
}));

router.post('/excel/import/auctions', wrap(async (req, res) => {
  const err = await runUpload(req, res);
  if (err) { req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB. Split it into smaller files.' : 'The upload failed. Try again.'); return res.redirect('/admin/excel'); }
  if (req.badUpload) { req.flash('error', `"${req.badUpload}" is not an .xlsx file. Save it from Excel as "Excel Workbook (*.xlsx)" and upload it again.`); return res.redirect('/admin/excel'); }
  const { wb, error } = await loadWorkbook(req.file);
  if (error) { req.flash('error', error); return res.redirect('/admin/excel'); }
  const aws = findSheet(wb, 'auctions');
  const lws = findSheet(wb, 'lots');
  const missing = [!aws && '"Auctions"', !lws && '"Lots"'].filter(Boolean);
  if (missing.length) { req.flash('error', `The workbook has no ${missing.join(' or ')} sheet. It needs a sheet named Auctions and a sheet named Lots: start from the auction import template.`); return res.redirect('/admin/excel'); }
  const ad = sheetRows(aws, 'ref');
  const ld = sheetRows(lws, 'auction_ref') || sheetRows(lws, 'auction ref');
  if (!ad) { req.flash('error', 'The Auctions sheet has no header row with a "ref" column in its first 10 rows. Required columns: ref, title, starts_at, ends_at.'); return res.redirect('/admin/excel'); }
  if (!ld) { req.flash('error', 'The Lots sheet has no header row with an "auction_ref" column in its first 10 rows. Required columns: auction_ref, title, quantity, unit, start_price.'); return res.redirect('/admin/excel'); }
  if (!ad.rows.length) { req.flash('error', 'The Auctions sheet has no auctions under the header row.'); return res.redirect('/admin/excel'); }
  if (ad.rows.length > 200) { req.flash('error', `The Auctions sheet has ${ad.rows.length} auctions. Import at most 200 at a time.`); return res.redirect('/admin/excel'); }
  if (ld.rows.length > MAX_ROWS) { req.flash('error', `The Lots sheet has ${ld.rows.length.toLocaleString('en-IN')} lots. Import at most ${MAX_ROWS.toLocaleString('en-IN')} at a time: split the file.`); return res.redirect('/admin/excel'); }
  req.session.xlImport = {
    id: token(8), kind: 'auctions', file: clean(req.file.originalname, 120), options: readOptions(req.body),
    auctions: { headers: ad.headers.map((h) => ({ key: h.key, label: h.label })), rows: pack(ad.rows) },
    lots: { headers: ld.headers.map((h) => ({ key: h.key, label: h.label })), rows: pack(ld.rows) },
  };
  audit(req, 'excel.import_preview', `auctions: ${req.file.originalname}, ${ad.rows.length} auctions, ${ld.rows.length} lots`);
  res.redirect('/admin/excel/import/review');
}));

const countBy = (items, s) => items.filter((i) => i.status === s).length;

router.get('/excel/import/review', wrap(async (req, res) => {
  const p = req.session.xlImport;
  if (!p) { req.flash('info', 'There is no import waiting. Upload a file to start.'); return res.redirect('/admin/excel'); }
  if (p.kind === 'lots') {
    const v = await validateLotsImport(db.pool, p);
    const ready = countBy(v.items, 'new') + countBy(v.items, 'update');
    return res.adminPage('admin/excel_preview', {
      title: 'Check the lot import', styles: STYLES, p, v, kind: 'lots', ready, only: req.query.only === 'problems',
      counts: { total: v.items.length, new: countBy(v.items, 'new'), update: countBy(v.items, 'update'), skip: countBy(v.items, 'skip'), error: countBy(v.items, 'error') },
      blocked: v.fatal.length > 0 || ready === 0 || (p.options.invalid === 'refuse' && countBy(v.items, 'error') > 0),
    });
  }
  const v = await validateAuctionsImport(db.pool, p);
  const lotsReady = v.lots.filter((l) => l.status === 'new' && l.parent && l.parent.status === 'new').length;
  const errors = countBy(v.auctions, 'error') + countBy(v.lots, 'error');
  res.adminPage('admin/excel_preview', {
    title: 'Check the auction import', styles: STYLES, p, v, kind: 'auctions', ready: countBy(v.auctions, 'new'), lotsReady, only: req.query.only === 'problems',
    counts: { auctions: v.auctions.length, auctionsOk: countBy(v.auctions, 'new'), auctionErrors: countBy(v.auctions, 'error'), lots: v.lots.length, lotErrors: countBy(v.lots, 'error'), lotSkips: countBy(v.lots, 'skip') },
    blocked: v.fatal.length > 0 || countBy(v.auctions, 'new') === 0 || (p.options.invalid === 'refuse' && errors > 0),
  });
}));

router.post('/excel/import/options', wrap(async (req, res) => {
  const p = req.session.xlImport;
  if (p && req.body.id === p.id) p.options = readOptions(req.body);
  res.redirect('/admin/excel/import/review');
}));

router.post('/excel/import/discard', wrap(async (req, res) => {
  delete req.session.xlImport;
  req.flash('info', 'The import was discarded. Nothing was saved.');
  res.redirect('/admin/excel');
}));

router.post('/excel/import/commit', wrap(async (req, res) => {
  const p = req.session.xlImport;
  if (!p || req.body.id !== p.id) { req.flash('error', 'This import is no longer waiting (it was committed, discarded or replaced by a newer upload). Upload the file again.'); return res.redirect('/admin/excel'); }
  if (p.kind === 'lots') {
    const out = await db.tx(async (c) => {
      await c.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [p.auctionId]);
      const v = await validateLotsImport(c, p);
      const errors = countBy(v.items, 'error');
      if (v.fatal.length) return { error: v.fatal[0] };
      if (p.options.invalid === 'refuse' && errors) return { error: `${errors} row${errors === 1 ? ' has' : 's have'} errors and "Refuse the whole file" is chosen. Fix the rows and upload again, or choose to skip invalid rows.` };
      let added = 0; let updated = 0;
      for (const it of v.items) {
        const d = it.data;
        if (it.status === 'new') {
          const lot = (await c.query(
            `INSERT INTO lots(auction_id, lot_no, title, description, quantity, unit, start_price, increment, reserve_price, specs, ends_at)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, a.ends_at FROM auctions a WHERE a.id = $1 RETURNING id`,
            [p.auctionId, d.lot_no, d.title, d.description, d.quantity, d.unit, d.start_price, d.increment, d.reserve_price, JSON.stringify(d.specs)]
          )).rows[0];
          for (const g of d.groupPrices) await c.query('INSERT INTO lot_group_prices(lot_id, group_id, start_price) VALUES($1,$2,$3) ON CONFLICT (lot_id, group_id) DO UPDATE SET start_price = EXCLUDED.start_price', [lot.id, g.group_id, g.start_price]);
          added++;
        } else if (it.status === 'update') {
          const k = v.keep;
          await c.query(
            `UPDATE lots SET title = $2, description = CASE WHEN $10 THEN description ELSE $3 END, quantity = $4, unit = $5, start_price = $6,
                    increment = CASE WHEN $12 THEN increment ELSE $7 END, reserve_price = CASE WHEN $13 THEN reserve_price ELSE $8 END,
                    specs = CASE WHEN $11 THEN specs ELSE $9::jsonb END
              WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = lots.id)`,
            [it.lotId, d.title, d.description, d.quantity, d.unit, d.start_price, d.increment, d.reserve_price, JSON.stringify(d.specs), k.description, k.specs, k.increment, k.reserve_price]
          );
          if (d.groupPrices.length) {
            await c.query('DELETE FROM lot_group_prices WHERE lot_id = $1', [it.lotId]);
            for (const g of d.groupPrices) await c.query('INSERT INTO lot_group_prices(lot_id, group_id, start_price) VALUES($1,$2,$3)', [it.lotId, g.group_id, g.start_price]);
          }
          updated++;
        }
      }
      return { added, updated, skipped: countBy(v.items, 'skip'), errors, auction: v.auction };
    });
    if (out.error) { req.flash('error', out.error); return res.redirect('/admin/excel/import/review'); }
    await bidding.recalcLotEnds(p.auctionId);
    delete req.session.xlImport;
    audit(req, 'excel.import_lots', `auction #${p.auctionId} from ${p.file}: ${out.added} added, ${out.updated} updated, ${out.skipped} skipped, ${out.errors} invalid rows left out`);
    req.flash('ok', `Imported into "${out.auction.title}": ${out.added} lot${out.added === 1 ? '' : 's'} added${out.updated ? `, ${out.updated} updated` : ''}${out.skipped ? `, ${out.skipped} skipped as duplicates` : ''}${out.errors ? `, ${out.errors} invalid row${out.errors === 1 ? '' : 's'} left out` : ''}.`);
    return res.redirect(`/admin/auctions/${p.auctionId}`);
  }

  const out = await db.tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('excel-import-auctions'))`);
    const v = await validateAuctionsImport(c, p);
    const errors = countBy(v.auctions, 'error') + countBy(v.lots, 'error');
    if (v.fatal.length) return { error: v.fatal[0] };
    if (p.options.invalid === 'refuse' && errors) return { error: `${errors} row${errors === 1 ? ' has' : 's have'} errors and "Refuse the whole file" is chosen. Fix them and upload again, or choose to skip invalid rows.` };
    const created = [];
    const newSellers = new Map();
    let lots = 0;
    for (const a of v.auctions) {
      if (a.status !== 'new') continue;
      const d = a.data;
      let sellerId = d.seller_id;
      if (d.newSeller) {
        const key = d.newSeller.toLowerCase();
        if (!newSellers.has(key)) newSellers.set(key, (await c.query('INSERT INTO sellers(name) VALUES($1) RETURNING id', [d.newSeller])).rows[0].id);
        sellerId = newSellers.get(key);
      }
      const row = (await c.query(
        `INSERT INTO auctions(title, seller_id, category, location, description, inspection, terms, starts_at, ends_at, status, visibility,
                              extend_window_min, extend_by_min, stagger_min)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13) RETURNING id`,
        [d.title, sellerId, d.category, d.location, d.description, d.inspection, d.terms, d.starts_at, d.ends_at, d.visibility, d.extend_window_min, d.extend_by_min, d.stagger_min]
      )).rows[0];
      created.push(row.id);
      for (const l of a.lots) {
        if (l.status !== 'new') continue;
        const ld = l.data;
        const lot = (await c.query(
          `INSERT INTO lots(auction_id, lot_no, title, description, quantity, unit, start_price, increment, reserve_price, specs, ends_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
          [row.id, ld.lot_no, ld.title, ld.description, ld.quantity, ld.unit, ld.start_price, ld.increment, ld.reserve_price, JSON.stringify(ld.specs), d.ends_at]
        )).rows[0];
        for (const g of ld.groupPrices) await c.query('INSERT INTO lot_group_prices(lot_id, group_id, start_price) VALUES($1,$2,$3)', [lot.id, g.group_id, g.start_price]);
        lots++;
      }
    }
    return { created, lots, sellers: newSellers.size, errors };
  });
  if (out.error) { req.flash('error', out.error); return res.redirect('/admin/excel/import/review'); }
  for (const id of out.created) await bidding.recalcLotEnds(id);
  delete req.session.xlImport;
  audit(req, 'excel.import_auctions', `from ${p.file}: auctions ${out.created.map((i) => '#' + i).join(', ')}, ${out.lots} lots, ${out.sellers} new sellers, ${out.errors} invalid rows left out`);
  req.flash('ok', `${out.created.length} draft auction${out.created.length === 1 ? '' : 's'} created with ${out.lots} lot${out.lots === 1 ? '' : 's'}${out.sellers ? ` and ${out.sellers} new seller${out.sellers === 1 ? '' : 's'}` : ''}${out.errors ? `; ${out.errors} invalid row${out.errors === 1 ? '' : 's'} left out` : ''}. Check each auction, add photos and publish it.`);
  res.redirect(out.created.length === 1 ? `/admin/auctions/${out.created[0]}` : '/admin/auctions?phase=draft');
}));

module.exports = router;
module.exports._test = { validateLotRow, classify, numberLots, LOT_COLS };
