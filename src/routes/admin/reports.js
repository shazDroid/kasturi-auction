// Reports: one page with a report picker and an IST date range; every report is a table with totals,
// downloadable as Excel (.xlsx) or CSV.
const express = require('express');
const db = require('../../db');
const settings = require('../../lib/settings');
const billing = require('../../lib/billing');
const xl = require('../../lib/excel');
const { bidderNo, toCsv, TZ } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');

const router = express.Router();
const STYLES = ['/css/admin-extra.css', '/css/admin-billing.css'];
const r2 = billing.round2;
const HTML_CAP = 500;
const EXPORT_CAP = 200000;

// ---------------------------------------------------------------------------------------------
// Date ranges (IST calendar days, inclusive)

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const PRESETS = {
  this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter', this_fy: 'This financial year', last_fy: 'Last financial year',
};

function presetRange(key, now = new Date()) {
  const [y, m] = billing.istDate(now).split('-').map(Number);
  const fyStart = m >= 4 ? y : y - 1;
  switch (key) {
    case 'this_month': return [ymd(y, m, 1), ymd(y, m, lastDay(y, m))];
    case 'last_month': { const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1; return [ymd(py, pm, 1), ymd(py, pm, lastDay(py, pm))]; }
    case 'this_quarter': { const qs = Math.floor((m - 1) / 3) * 3 + 1; return [ymd(y, qs, 1), ymd(y, qs + 2, lastDay(y, qs + 2))]; }
    case 'last_fy': return [ymd(fyStart - 1, 4, 1), ymd(fyStart, 3, 31)];
    default: return [ymd(fyStart, 4, 1), ymd(fyStart + 1, 3, 31)];
  }
}

function resolveRange(q) {
  if (isDate(q.from) && isDate(q.to)) {
    let [from, to] = [q.from, q.to];
    if (from > to) [from, to] = [to, from];
    const match = Object.keys(PRESETS).find((k) => { const [f, t] = presetRange(k); return f === from && t === to; });
    return { from, to, preset: match || 'custom' };
  }
  const preset = PRESETS[q.preset] ? q.preset : 'this_fy';
  const [from, to] = presetRange(preset);
  return { from, to, preset };
}

// SQL bounds for a timestamptz column: >= start of `from` and < end of `to`, in IST.
const inRange = (col, a, b) => `${col} >= ($${a} || 'T00:00:00+05:30')::timestamptz AND ${col} < ($${b} || 'T00:00:00+05:30')::timestamptz + interval '1 day'`;

const pctOf = (part, whole) => (whole > 0 ? r2((part / whole) * 100) : null);
const sum = (rows, k) => r2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
const isum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const monthLabel = (ym) => new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(ym + '-01T00:00:00Z'));
const toX = xl.toExcelDate;

// ---------------------------------------------------------------------------------------------
// Charts: plain bar chart data, rendered as inline SVG by the view.

function barChart(title, items, { unit = 'INR', money = true, note = '' } = {}) {
  if (!items.length || !items.some((i) => i.value > 0)) return null;
  const W = 760; const H = 210; const left = 64; const right = 8; const top = 12; const baseY = H - 30;
  const max = Math.max(...items.map((i) => i.value));
  const step = niceStep(max / 4);
  const scaleMax = Math.ceil(max / step) * step || 1;
  const ticks = [];
  for (let v = 0; v <= scaleMax + step * 0.001; v += step) ticks.push({ v, y: baseY - (v / scaleMax) * (baseY - top) });
  const slot = (W - left - right) / items.length;
  const bw = Math.min(46, slot * 0.66);
  const every = Math.ceil(items.length / 14);
  const bars = items.map((it, i) => {
    const h = (it.value / scaleMax) * (baseY - top);
    return { ...it, x: left + i * slot + (slot - bw) / 2, w: bw, y: baseY - h, h, showLabel: i % every === 0 };
  });
  return { title, unit, money, note, W, H, left, right, top, baseY, ticks: ticks.map((t) => ({ ...t, label: shortNum(t.v) })), bars };
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
/** 1250000 -> "12.5 L", 32000000 -> "3.2 Cr" (Indian units for axis labels). */
function shortNum(v) {
  if (v >= 1e7) return +(v / 1e7).toFixed(2) + ' Cr';
  if (v >= 1e5) return +(v / 1e5).toFixed(2) + ' L';
  if (v >= 1e3) return +(v / 1e3).toFixed(1) + ' K';
  return String(+v.toFixed(2));
}

// ---------------------------------------------------------------------------------------------
// Report definitions. Each run(from, to, opts) returns { tables: [{ name, columns, rows, totals, note }], chart? }.

const LOTS_CTE = `lt AS (
  SELECT l.id, l.auction_id, l.lot_no, l.title, l.result, l.status, l.quantity, l.unit, l.start_price, l.buyer_paid_at, l.lifted_at,
         w.amount AS rate, w.user_id AS winner_id,
         CASE WHEN l.result = 'awarded' THEN round(w.amount * l.quantity, 2) END AS value,
         CASE WHEN l.result = 'awarded' THEN COALESCE(l.commission_percent, g.commission_percent, $3::numeric) END AS pct
    FROM lots l LEFT JOIN bids w ON w.id = l.winning_bid_id LEFT JOIN users u ON u.id = w.user_id
    LEFT JOIN bidder_groups g ON g.id = u.group_id)`;
const COMM = 'round(lt.value * lt.pct / 100, 2)';

const REPORTS = {
  auctions: {
    name: 'Auction summary',
    help: 'Published auctions closing in the period. Sold value is the winning rate times quantity of awarded lots; uplift compares it with the start value of the same lots.',
    async run(from, to) {
      const rows = await db.many(
        `WITH ${LOTS_CTE}
         SELECT a.id, a.title, s.name AS seller, a.starts_at, a.ends_at,
                count(lt.id)::int AS lots,
                count(lt.id) FILTER (WHERE lt.result = 'awarded')::int AS sold,
                count(lt.id) FILTER (WHERE lt.result IN ('rejected','no_bids'))::int AS unsold,
                count(lt.id) FILTER (WHERE lt.result = 'pending')::int AS pending,
                (SELECT count(DISTINCT b.user_id) FROM bids b JOIN lots x ON x.id = b.lot_id WHERE x.auction_id = a.id AND NOT b.cancelled)::int AS bidders,
                (SELECT count(*) FROM bids b JOIN lots x ON x.id = b.lot_id WHERE x.auction_id = a.id AND NOT b.cancelled)::int AS bids,
                COALESCE(sum(round(lt.start_price * lt.quantity, 2)), 0) AS start_value,
                COALESCE(sum(round(lt.start_price * lt.quantity, 2)) FILTER (WHERE lt.result = 'awarded'), 0) AS sold_start,
                COALESCE(sum(lt.value), 0) AS sold_value,
                COALESCE(sum(${COMM}), 0) AS commission
           FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id LEFT JOIN lt ON lt.auction_id = a.id
          WHERE a.status = 'published' AND ${inRange('a.ends_at', 1, 2)}
          GROUP BY a.id, s.name ORDER BY a.ends_at, a.id`, [from, to, settings.num('default_commission_percent')]
      );
      for (const r of rows) { r.uplift = pctOf(r.sold_value - r.sold_start, r.sold_start); r.ends = toX(r.ends_at); r.starts = toX(r.starts_at); }
      const sstart = sum(rows, 'sold_start'); const svalue = sum(rows, 'sold_value');
      const totals = {
        title: `${rows.length} auction${rows.length === 1 ? '' : 's'}`, lots: isum(rows, 'lots'), sold: isum(rows, 'sold'), unsold: isum(rows, 'unsold'), pending: isum(rows, 'pending'),
        bids: isum(rows, 'bids'), start_value: sum(rows, 'start_value'), sold_value: svalue, uplift: pctOf(svalue - sstart, sstart), commission: sum(rows, 'commission'),
      };
      return {
        tables: [{
          name: 'Auction summary',
          columns: [
            { header: 'Auction', key: 'title', wrap: true, link: (r) => r.id && `/admin/auctions/${r.id}` }, { header: 'Seller', key: 'seller', wrap: true },
            { header: 'Closes (IST)', key: 'ends', type: 'datetime' }, { header: 'Lots', key: 'lots', type: 'int' }, { header: 'Sold', key: 'sold', type: 'int' },
            { header: 'Unsold or no bids', key: 'unsold', type: 'int' }, { header: 'Awaiting decision', key: 'pending', type: 'int' },
            { header: 'Bidders', key: 'bidders', type: 'int' }, { header: 'Bids', key: 'bids', type: 'int' },
            { header: 'Start value (INR)', key: 'start_value', type: 'money' }, { header: 'Sold value (INR)', key: 'sold_value', type: 'money' },
            { header: 'Uplift on sold lots', key: 'uplift', type: 'pct' }, { header: 'Commission (INR)', key: 'commission', type: 'money' },
          ],
          rows, totals, note: 'The bidders total is left out because one bidder can take part in several auctions.',
        }],
        chart: barChart('Sold value per auction', rows.slice(-30).map((r) => ({ label: new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: TZ }).format(r.ends_at), title: r.title, value: r.sold_value })),
          { note: rows.length > 30 ? 'The latest 30 auctions in the period, by closing date.' : 'By closing date.' }),
      };
    },
  },

  lots: {
    name: 'Lot register',
    help: 'Every lot of the published auctions closing in the period, with its result, buyer, value, commission and settlement.',
    async run(from, to) {
      const rows = await db.many(
        `WITH ${LOTS_CTE}
         SELECT lt.*, a.title AS auction, a.ends_at, u.name AS winner, u.company_name AS winner_company, so.number AS so_number
           FROM lt JOIN auctions a ON a.id = lt.auction_id LEFT JOIN users u ON u.id = lt.winner_id AND lt.result IN ('awarded','pending')
           LEFT JOIN sale_orders so ON so.lot_id = lt.id
          WHERE a.status = 'published' AND ${inRange('a.ends_at', 1, 2)}
          ORDER BY a.ends_at, a.id, lt.lot_no`, [from, to, settings.num('default_commission_percent')]
      );
      const RES = { pending: 'Awaiting decision', awarded: 'Awarded', rejected: 'Rejected', no_bids: 'No bids' };
      for (const r of rows) {
        r.result_label = r.status === 'open' ? 'Open' : RES[r.result] || '';
        r.buyer = r.winner ? [r.winner_company, r.winner].filter(Boolean).join(', ') : '';
        r.commission = r.result === 'awarded' ? r2(r.value * r.pct / 100) : null;
        r.rate_shown = r.result === 'awarded' || r.result === 'pending' ? r.rate : null;
        r.paid = toX(r.buyer_paid_at); r.lifted = toX(r.lifted_at); r.lot = `Lot ${r.lot_no}: ${r.title}`;
      }
      return {
        tables: [{
          name: 'Lot register',
          columns: [
            { header: 'Auction', key: 'auction', wrap: true }, { header: 'Lot', key: 'lot', wrap: true, link: (r) => r.id && `/admin/lots/${r.id}` },
            { header: 'Result', key: 'result_label' }, { header: 'Buyer or highest bidder', key: 'buyer', wrap: true },
            { header: 'Rate (INR)', key: 'rate_shown', type: 'money' }, { header: 'Quantity', key: 'quantity', type: 'num' }, { header: 'Unit', key: 'unit' },
            { header: 'Sold value (INR)', key: 'value', type: 'money' }, { header: 'Commission %', key: 'pct', type: 'pct' }, { header: 'Commission (INR)', key: 'commission', type: 'money' },
            { header: 'Sale order', key: 'so_number' }, { header: 'Buyer paid', key: 'paid', type: 'date' }, { header: 'Lifted', key: 'lifted', type: 'date' },
          ],
          rows,
          totals: { auction: `${rows.length} lots, ${rows.filter((r) => r.result === 'awarded').length} awarded`, value: sum(rows, 'value'), commission: sum(rows, 'commission') },
        }],
      };
    },
  },

  bidders: {
    name: 'Bidder activity',
    help: 'Bids placed in the period, lots won in auctions closing in the period, and fees paid in the period. Outstanding is the unpaid invoice balance today.',
    async run(from, to) {
      const rows = await db.many(
        `SELECT u.id, u.name, u.company_name, COALESCE(g.name, '') AS grp,
                (SELECT count(DISTINCT x.auction_id) FROM bids b JOIN lots x ON x.id = b.lot_id WHERE b.user_id = u.id AND NOT b.cancelled AND ${inRange('b.created_at', 1, 2)})::int AS auctions,
                (SELECT count(*) FROM bids b WHERE b.user_id = u.id AND NOT b.cancelled AND ${inRange('b.created_at', 1, 2)})::int AS bids,
                (SELECT count(DISTINCT x.id) FROM bids b JOIN lots x ON x.id = b.lot_id WHERE b.user_id = u.id AND NOT b.cancelled
                    AND x.result IN ('awarded','rejected','pending') AND ${inRange('x.ends_at', 1, 2)})::int AS lots_decided,
                (SELECT count(*) FROM lots x JOIN bids w ON w.id = x.winning_bid_id WHERE w.user_id = u.id AND x.result = 'awarded' AND ${inRange('x.ends_at', 1, 2)})::int AS won,
                (SELECT COALESCE(sum(round(w.amount * x.quantity, 2)), 0) FROM lots x JOIN bids w ON w.id = x.winning_bid_id WHERE w.user_id = u.id AND x.result = 'awarded' AND ${inRange('x.ends_at', 1, 2)}) AS value_won,
                (SELECT COALESCE(sum(p.amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND ${inRange('p.paid_at', 1, 2)}) AS fees,
                (SELECT COALESCE(sum(i.total - COALESCE((SELECT sum(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0)), 0)
                   FROM invoices i WHERE i.user_id = u.id AND i.status IN ('unpaid','part_paid')) AS outstanding
           FROM users u LEFT JOIN bidder_groups g ON g.id = u.group_id
          ORDER BY u.company_name, u.name`, [from, to]
      );
      const act = rows.filter((r) => r.bids || r.won || r.fees > 0 || r.outstanding > 0);
      for (const r of act) { r.bidder_no = bidderNo(r.id); r.win_rate = r.lots_decided ? pctOf(r.won, r.lots_decided) : null; r.label = r.company_name || r.name; }
      return {
        tables: [{
          name: 'Bidder activity',
          columns: [
            { header: 'Bidder no', key: 'bidder_no' }, { header: 'Company', key: 'label', wrap: true, link: (r) => r.id && `/admin/bidders/${r.id}` }, { header: 'Contact', key: 'name' },
            { header: 'Group', key: 'grp' }, { header: 'Auctions', key: 'auctions', type: 'int' }, { header: 'Bids', key: 'bids', type: 'int' },
            { header: 'Lots won', key: 'won', type: 'int' }, { header: 'Value won (INR)', key: 'value_won', type: 'money' }, { header: 'Win rate', key: 'win_rate', type: 'pct' },
            { header: 'Fees paid (INR)', key: 'fees', type: 'money' }, { header: 'Outstanding today (INR)', key: 'outstanding', type: 'money', link: (r) => r.id && r.outstanding > 0 && `/admin/billing/statement/${r.id}` },
          ],
          rows: act,
          totals: { bidder_no: `${act.length} bidders`, bids: isum(act, 'bids'), won: isum(act, 'won'), value_won: sum(act, 'value_won'), fees: sum(act, 'fees'), outstanding: sum(act, 'outstanding') },
          note: 'Win rate is lots won out of the closed lots the bidder bid on that were decided (awarded, rejected or awaiting decision).',
        }],
      };
    },
  },

  sellers: {
    name: 'Seller summary',
    help: 'Published auctions closing in the period, by seller.',
    async run(from, to) {
      const rows = await db.many(
        `WITH ${LOTS_CTE}
         SELECT COALESCE(s.id, 0) AS id, COALESCE(s.name, 'No seller') AS seller, COALESCE(s.location, '') AS location,
                count(DISTINCT a.id)::int AS auctions, count(lt.id)::int AS lots,
                count(lt.id) FILTER (WHERE lt.result = 'awarded')::int AS sold,
                COALESCE(sum(round(lt.start_price * lt.quantity, 2)), 0) AS start_value,
                COALESCE(sum(lt.value), 0) AS sold_value, COALESCE(sum(${COMM}), 0) AS commission
           FROM auctions a LEFT JOIN sellers s ON s.id = a.seller_id LEFT JOIN lt ON lt.auction_id = a.id
          WHERE a.status = 'published' AND ${inRange('a.ends_at', 1, 2)}
          GROUP BY s.id, s.name, s.location ORDER BY sold_value DESC, seller`, [from, to, settings.num('default_commission_percent')]
      );
      for (const r of rows) r.sell_through = pctOf(r.sold, r.lots);
      return {
        tables: [{
          name: 'Seller summary',
          columns: [
            { header: 'Seller', key: 'seller', wrap: true }, { header: 'Location', key: 'location', wrap: true }, { header: 'Auctions', key: 'auctions', type: 'int' },
            { header: 'Lots listed', key: 'lots', type: 'int' }, { header: 'Lots sold', key: 'sold', type: 'int' }, { header: 'Sold %', key: 'sell_through', type: 'pct' },
            { header: 'Start value (INR)', key: 'start_value', type: 'money' }, { header: 'Value sold (INR)', key: 'sold_value', type: 'money' }, { header: 'Commission (INR)', key: 'commission', type: 'money' },
          ],
          rows,
          totals: { seller: `${rows.length} sellers`, auctions: isum(rows, 'auctions'), lots: isum(rows, 'lots'), sold: isum(rows, 'sold'), sell_through: pctOf(isum(rows, 'sold'), isum(rows, 'lots')),
            start_value: sum(rows, 'start_value'), sold_value: sum(rows, 'sold_value'), commission: sum(rows, 'commission') },
        }],
      };
    },
  },

  fees: {
    name: 'Fee collection',
    help: 'Registration fees paid in the period (refunded payments are left out), by month and by bidder group.',
    async run(from, to) {
      const base = `FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN bidder_groups g ON g.id = u.group_id
        WHERE p.status = 'paid' AND p.purpose = 'registration_fee' AND ${inRange('p.paid_at', 1, 2)}`;
      const cols = `count(*)::int AS n, COALESCE(sum(p.base_amount), 0) AS base, COALESCE(sum(p.tax_amount), 0) AS tax, COALESCE(sum(p.amount), 0) AS total,
        count(*) FILTER (WHERE p.method = 'razorpay')::int AS rp_n, COALESCE(sum(p.amount) FILTER (WHERE p.method = 'razorpay'), 0) AS rp_amount,
        count(*) FILTER (WHERE p.method = 'offline')::int AS off_n, COALESCE(sum(p.amount) FILTER (WHERE p.method = 'offline'), 0) AS off_amount`;
      const byMonth = await db.many(`SELECT to_char(p.paid_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS ym, ${cols} ${base} GROUP BY 1 ORDER BY 1`, [from, to]);
      const byGroup = await db.many(`SELECT COALESCE(g.name, 'No group') AS grp, ${cols} ${base} GROUP BY 1 ORDER BY total DESC, grp`, [from, to]);
      // Every month of the range, with zeros for months without payments.
      const months = [];
      let [y, m] = from.split('-').map(Number);
      const [ty, tm] = to.split('-').map(Number);
      while ((y < ty || (y === ty && m <= tm)) && months.length < 60) { months.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
      const map = Object.fromEntries(byMonth.map((r) => [r.ym, r]));
      const monthRows = months.map((ym) => ({ ...(map[ym] || { n: 0, base: 0, tax: 0, total: 0, rp_n: 0, rp_amount: 0, off_n: 0, off_amount: 0 }), ym, month: monthLabel(ym) }));
      const metric = [
        { header: 'Payments', key: 'n', type: 'int' }, { header: 'Base (INR)', key: 'base', type: 'money' }, { header: 'GST (INR)', key: 'tax', type: 'money' },
        { header: 'Total (INR)', key: 'total', type: 'money' }, { header: 'Razorpay payments', key: 'rp_n', type: 'int' }, { header: 'Razorpay (INR)', key: 'rp_amount', type: 'money' },
        { header: 'Offline payments', key: 'off_n', type: 'int' }, { header: 'Offline (INR)', key: 'off_amount', type: 'money' },
      ];
      const tot = (rows, first) => ({ ...first, n: isum(rows, 'n'), base: sum(rows, 'base'), tax: sum(rows, 'tax'), total: sum(rows, 'total'), rp_n: isum(rows, 'rp_n'), rp_amount: sum(rows, 'rp_amount'), off_n: isum(rows, 'off_n'), off_amount: sum(rows, 'off_amount') });
      return {
        tables: [
          { name: 'By month', columns: [{ header: 'Month', key: 'month' }, ...metric], rows: monthRows, totals: tot(monthRows, { month: 'Total' }) },
          { name: 'By group', columns: [{ header: 'Bidder group', key: 'grp' }, ...metric], rows: byGroup, totals: tot(byGroup, { grp: 'Total' }), note: "Grouped by each bidder's current group." },
        ],
        chart: monthRows.length > 1 ? barChart('Fees collected by month', monthRows.map((r) => ({ label: r.month, title: r.month, value: r.total }))) : null,
      };
    },
  },

  register: {
    name: 'Billing register (GST)',
    help: 'Every invoice issued in the period with its taxable value and GST heads. Cancelled invoices are listed but left out of the totals.',
    async run(from, to) {
      const rows = await db.many(
        `SELECT i.*, u.name, u.company_name FROM invoices i JOIN users u ON u.id = i.user_id
          WHERE ${inRange('i.issued_at', 1, 2)} ORDER BY i.issued_at, i.id`, [from, to]
      );
      for (const r of rows) {
        const t = billing.taxHeads(r.snapshot);
        const bt = r.snapshot.bill_to || {};
        Object.assign(r, t, {
          date: xl.dateOnly(billing.istDate(r.issued_at)), party: bt.company || bt.name || r.company_name || r.name, gstin: bt.gstin || '', state: r.snapshot.place_of_supply || '',
          kind_label: billing.KINDS[r.kind] || r.kind, status_label: billing.STATUSES[r.status] || r.status, taxable: r.subtotal,
        });
      }
      const live = rows.filter((r) => r.status !== 'cancelled');
      return {
        tables: [{
          name: 'Billing register',
          columns: [
            { header: 'Invoice no', key: 'number', link: (r) => r.id && `/admin/billing/invoices/${r.id}` }, { header: 'Date', key: 'date', type: 'date' },
            { header: 'Bill to', key: 'party', wrap: true }, { header: 'GSTIN', key: 'gstin' }, { header: 'Place of supply', key: 'state' }, { header: 'Kind', key: 'kind_label' },
            { header: 'Taxable value (INR)', key: 'taxable', type: 'money' }, { header: 'CGST (INR)', key: 'cgst', type: 'money' }, { header: 'SGST (INR)', key: 'sgst', type: 'money' },
            { header: 'IGST (INR)', key: 'igst', type: 'money' }, { header: 'Total (INR)', key: 'total', type: 'money' }, { header: 'Status', key: 'status_label' },
          ],
          rows,
          totals: { number: `${live.length} invoices`, taxable: sum(live, 'taxable'), cgst: sum(live, 'cgst'), sgst: sum(live, 'sgst'), igst: sum(live, 'igst'), total: sum(live, 'total') },
        }],
      };
    },
  },

  outstanding: {
    name: 'Outstanding',
    help: 'Unpaid and part-paid invoices issued in the period, by bidder, aged by days since the invoice date (as of today).',
    async run(from, to) {
      const rows = await db.many(
        `WITH o AS (
           SELECT i.user_id, i.total - COALESCE((SELECT sum(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0) AS bal,
                  ((now() AT TIME ZONE 'Asia/Kolkata')::date - (i.issued_at AT TIME ZONE 'Asia/Kolkata')::date) AS age,
                  (i.due_at IS NOT NULL AND i.due_at < now()) AS overdue
             FROM invoices i WHERE i.status IN ('unpaid','part_paid') AND ${inRange('i.issued_at', 1, 2)})
         SELECT u.id, u.name, u.company_name, count(*)::int AS invoices, count(*) FILTER (WHERE o.overdue)::int AS overdue,
                COALESCE(sum(o.bal) FILTER (WHERE o.age <= 7), 0) AS b0, COALESCE(sum(o.bal) FILTER (WHERE o.age BETWEEN 8 AND 30), 0) AS b8,
                COALESCE(sum(o.bal) FILTER (WHERE o.age BETWEEN 31 AND 60), 0) AS b31, COALESCE(sum(o.bal) FILTER (WHERE o.age > 60), 0) AS b60,
                COALESCE(sum(o.bal), 0) AS total, max(o.age) AS oldest
           FROM o JOIN users u ON u.id = o.user_id GROUP BY u.id ORDER BY total DESC`, [from, to]
      );
      for (const r of rows) { r.bidder_no = bidderNo(r.id); r.label = r.company_name || r.name; }
      return {
        tables: [{
          name: 'Outstanding',
          columns: [
            { header: 'Bidder no', key: 'bidder_no' }, { header: 'Bidder', key: 'label', wrap: true, link: (r) => r.id && `/admin/billing/statement/${r.id}` },
            { header: 'Invoices', key: 'invoices', type: 'int' }, { header: 'Overdue', key: 'overdue', type: 'int' },
            { header: '0 to 7 days (INR)', key: 'b0', type: 'money' }, { header: '8 to 30 days (INR)', key: 'b8', type: 'money' },
            { header: '31 to 60 days (INR)', key: 'b31', type: 'money' }, { header: 'Over 60 days (INR)', key: 'b60', type: 'money' },
            { header: 'Total due (INR)', key: 'total', type: 'money' }, { header: 'Oldest (days)', key: 'oldest', type: 'int' },
          ],
          rows,
          totals: { bidder_no: `${rows.length} bidders`, invoices: isum(rows, 'invoices'), overdue: isum(rows, 'overdue'), b0: sum(rows, 'b0'), b8: sum(rows, 'b8'), b31: sum(rows, 'b31'), b60: sum(rows, 'b60'), total: sum(rows, 'total') },
        }],
      };
    },
  },

  bids: {
    name: 'Bid log',
    help: 'Every bid placed in the period, including cancelled bids and bids placed by auto-bidding.',
    async run(from, to, { limit }) {
      const { n } = await db.one(`SELECT count(*)::int AS n FROM bids b WHERE ${inRange('b.created_at', 1, 2)}`, [from, to]);
      const rows = await db.many(
        `SELECT b.id, b.created_at, b.amount, b.auto, b.cancelled, b.cancel_note, b.ip, b.user_id, u.name, u.company_name,
                l.id AS lot_id, l.lot_no, l.title AS lot_title, a.title AS auction
           FROM bids b JOIN users u ON u.id = b.user_id JOIN lots l ON l.id = b.lot_id JOIN auctions a ON a.id = l.auction_id
          WHERE ${inRange('b.created_at', 1, 2)} ORDER BY b.created_at, b.id LIMIT $3`, [from, to, limit]
      );
      for (const r of rows) {
        r.at = toX(r.created_at); r.lot = `Lot ${r.lot_no}: ${r.lot_title}`; r.bidder = `${r.company_name || r.name} (${bidderNo(r.user_id)})`;
        r.auto_label = r.auto ? 'Auto' : 'Manual'; r.state = r.cancelled ? `Cancelled${r.cancel_note ? ': ' + r.cancel_note : ''}` : 'Valid';
      }
      const valid = rows.filter((r) => !r.cancelled);
      return {
        total: n,
        tables: [{
          name: 'Bid log',
          columns: [
            { header: 'Time (IST)', key: 'at', type: 'datetime' }, { header: 'Auction', key: 'auction', wrap: true }, { header: 'Lot', key: 'lot', wrap: true, link: (r) => r.lot_id && `/admin/lots/${r.lot_id}` },
            { header: 'Bidder', key: 'bidder', wrap: true }, { header: 'Amount (INR)', key: 'amount', type: 'money' }, { header: 'Placed by', key: 'auto_label' },
            { header: 'Status', key: 'state', wrap: true }, { header: 'IP address', key: 'ip' },
          ],
          rows,
          totals: { auction: `${n} bids, ${rows.filter((r) => r.auto).length} by auto-bidding${rows.length < n ? ' (in the rows shown)' : ''}`, amount: null },
          note: valid.length !== rows.length ? `${rows.length - valid.length} cancelled bid${rows.length - valid.length === 1 ? '' : 's'} included.` : '',
        }],
      };
    },
  },
};

// ---------------------------------------------------------------------------------------------

// HTML cell text. Dates in rows are Excel-style (IST wall clock stored as UTC), so they are formatted in UTC.
const utcDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const utcTime = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' });
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const n3 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
function fmtCell(v, type) {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money': return (v < 0 ? '-₹' : '₹') + inr.format(Math.abs(v));
    case 'int': return inr.format(v);
    case 'num': return n3.format(v);
    case 'pct': return inr.format(v) + '%';
    case 'date': return v instanceof Date ? utcDate.format(v) : String(v);
    case 'datetime': return v instanceof Date ? `${utcDate.format(v)}, ${utcTime.format(v).toLowerCase()}` : String(v);
    default: return String(v);
  }
}
const NUMERIC = ['money', 'int', 'num', 'pct'];

function parse(req) {
  const key = REPORTS[req.query.r] ? req.query.r : 'auctions';
  return { key, report: REPORTS[key], ...resolveRange(req.query) };
}
const periodText = (from, to) => `Period: ${from.split('-').reverse().join('-')} to ${to.split('-').reverse().join('-')} (IST)`;

router.get('/reports', wrap(async (req, res) => {
  const p = parse(req);
  const out = await p.report.run(p.from, p.to, { limit: HTML_CAP });
  res.adminPage('admin/reports', {
    title: 'Reports', styles: STYLES, REPORTS, PRESETS, p, out, HTML_CAP, fmtCell, NUMERIC,
    qs: (extra) => new URLSearchParams({ r: p.key, from: p.from, to: p.to, ...extra }).toString(),
    presetQs: (k) => new URLSearchParams({ r: p.key, preset: k }).toString(),
  });
}));

router.get('/reports/export', wrap(async (req, res) => {
  const p = parse(req);
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const out = await p.report.run(p.from, p.to, { limit: EXPORT_CAP });
  const fname = `${p.key}-${p.from}-to-${p.to}`;
  audit(req, 'report.export', `${p.report.name} ${p.from} to ${p.to} (${format})`);
  const capNote = out.total && out.total > EXPORT_CAP ? `Only the first ${EXPORT_CAP} of ${out.total} rows are included. Choose a shorter period for the rest.` : '';
  if (format === 'csv') {
    const lines = [];
    out.tables.forEach((t, i) => {
      if (out.tables.length > 1) { if (i) lines.push([]); lines.push([t.name]); }
      lines.push(...xl.tableCsv(t));
    });
    if (capNote) lines.push([], [capNote]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${fname}.csv"`);
    return res.send('﻿' + toCsv(lines));
  }
  const wb = xl.workbook();
  for (const t of out.tables) {
    xl.addTable(wb, out.tables.length > 1 ? t.name : p.report.name, {
      title: out.tables.length > 1 ? `${p.report.name}: ${t.name}` : p.report.name,
      filters: [periodText(p.from, p.to), p.report.help],
      note: [t.note, capNote].filter(Boolean).join(' '),
      columns: t.columns.map(({ header, key, type, wrap: w }) => ({ header, key, type, width: w ? 40 : undefined, wrap: !!w })),
      rows: t.rows, totals: t.totals,
    });
  }
  await xl.send(res, wb, `${fname}.xlsx`);
}));

module.exports = router;
module.exports.presetRange = presetRange;
