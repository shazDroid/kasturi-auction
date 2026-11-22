const crypto = require('crypto');

const TZ = 'Asia/Kolkata';
const TZ_OFFSET = '+05:30';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
/** 125000 -> "₹1,25,000" */
const fmtINR = (n) => (n === null || n === undefined || n === '' ? '' : '₹' + inr.format(Number(n)));
const fmtNum = (n) => (n === null || n === undefined ? '' : inr.format(Number(n)));

const dtf = (opts) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...opts });
const fDate = dtf({ day: 'numeric', month: 'short', year: 'numeric' });
const fTime = dtf({ hour: 'numeric', minute: '2-digit', hour12: true });
const fDay = dtf({ weekday: 'short' });
/** "22 Nov 2026" */
const fmtDate = (d) => (d ? fDate.format(new Date(d)) : '');
/** "3:00 pm" */
const fmtTime = (d) => (d ? fTime.format(new Date(d)).toLowerCase() : '');
/** "22 Nov 2026, 3:00 pm" */
const fmtDT = (d) => (d ? `${fmtDate(d)}, ${fmtTime(d)}` : '');
const fmtDay = (d) => (d ? fDay.format(new Date(d)) : '');

/** Date -> value for <input type="datetime-local">, in IST. */
function toLocalInput(d) {
  if (!d) return '';
  const p = Object.fromEntries(
    dtf({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(d)).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** "2026-11-22T15:00" typed by an admin (IST) -> Date, or null if invalid. */
function parseLocal(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s || ''))) return null;
  const d = new Date(String(s).slice(0, 16) + ':00' + TZ_OFFSET);
  return isNaN(d) ? null : d;
}

const token = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
/** Bidder number shown in the UI: KA-00012 */
const bidderNo = (id) => 'KA-' + String(id).padStart(5, '0');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Plain text with newlines -> safe HTML paragraphs. */
const nl2p = (s) => String(s || '').split(/\n{2,}/).filter((x) => x.trim()).map((x) => `<p>${escapeHtml(x.trim()).replace(/\n/g, '<br>')}</p>`).join('');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || ''));
const clean = (s, max = 500) => String(s ?? '').trim().slice(0, max);
const toInt = (v, def = 0) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
/** Parse money typed by a user; returns a number with max 2 decimals, or NaN. */
function toMoney(v) {
  const s = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Number(s);
}
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

module.exports = {
  TZ, fmtINR, fmtNum, fmtDate, fmtTime, fmtDT, fmtDay, toLocalInput, parseLocal,
  token, bidderNo, escapeHtml, nl2p, isEmail, clean, toInt, toMoney, toCsv,
};
