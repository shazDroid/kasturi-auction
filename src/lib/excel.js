// Excel helpers shared by reports, billing and the import/export screens (exceljs).
// Dates: Excel has no time zones, so every date is written as its IST wall-clock time and read back as IST.
const ExcelJS = require('exceljs');
const { TZ } = require('./util');

const IST_MS = 330 * 60000;
const MONEY_FMT = '"₹"#,##0.00;-"₹"#,##0.00';
const FORMATS = {
  money: MONEY_FMT, int: '#,##0', num: '#,##0.###', pct: '0.00"%"', date: 'dd-mmm-yyyy', datetime: 'dd-mmm-yyyy hh:mm',
};
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6EBF1' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F9' } };

function workbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kasturi Auction';
  wb.created = new Date();
  return wb;
}

/** An instant -> a Date whose UTC fields are the IST wall-clock time (what Excel should display). */
const toExcelDate = (d) => (d === null || d === undefined || d === '' ? null : new Date(new Date(d).getTime() + IST_MS));
/** "YYYY-MM-DD" -> Excel date (no time). */
const dateOnly = (s) => (s ? new Date(String(s).slice(0, 10) + 'T00:00:00Z') : null);
const nowText = () => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date()) + ' IST';

/** Sheet names: max 31 chars, none of : \ / ? * [ ]. */
const sheetName = (s) => String(s || 'Sheet').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';

/**
 * Text for a cell. exceljs writes strings as string cells (never formulas), and we also guard
 * against values that a spreadsheet might evaluate if a user re-types them: leading = + - @ get a
 * leading apostrophe only in CSV (see util.toCsv); here the cell type is explicitly string.
 */
const textValue = (v) => (v === null || v === undefined ? null : String(v));

function displayLen(v, type) {
  if (v === null || v === undefined) return 0;
  if (type === 'date') return 11;
  if (type === 'datetime') return 17;
  if (typeof v === 'number') return (type === 'money' ? 4 : 0) + v.toLocaleString('en-IN', { maximumFractionDigits: 3 }).length;
  return Math.max(...String(v).split('\n').map((l) => l.length));
}

/**
 * Add a formatted table sheet.
 * def: { title?, filters?: [string], columns: [{header, key, type?: text|money|int|num|pct|date|datetime, width?}],
 *        rows: [object], totals?: object, note? }
 * Without a title the header is row 1 (for files meant to be edited and imported again).
 */
function addTable(wb, name, def) {
  const ws = wb.addWorksheet(sheetName(name));
  let r = 1;
  if (def.title) {
    ws.getCell(r, 1).value = textValue(def.title);
    ws.getCell(r, 1).font = { bold: true, size: 14 };
    r++;
    for (const f of def.filters || []) { ws.getCell(r, 1).value = textValue(f); ws.getCell(r, 1).font = { color: { argb: 'FF4A5868' } }; r++; }
    ws.getCell(r, 1).value = `Generated ${nowText()}`;
    ws.getCell(r, 1).font = { color: { argb: 'FF4A5868' }, italic: true };
    r++;
    if (def.note) { ws.getCell(r, 1).value = textValue(def.note); ws.getCell(r, 1).font = { color: { argb: 'FF8A4B00' } }; r++; }
    r++;
  }
  const headerRow = r;
  const cols = def.columns;
  cols.forEach((c, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = c.header;
    cell.font = { bold: true };
    cell.fill = HEAD_FILL;
    cell.alignment = { vertical: 'middle', horizontal: ['money', 'int', 'num', 'pct'].includes(c.type) ? 'right' : 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9AA7B6' } } };
  });
  ws.getRow(headerRow).height = 20;
  const widths = cols.map((c) => Math.max(8, String(c.header).length + 2));
  const put = (rowIdx, obj, bold) => {
    cols.forEach((c, i) => {
      const cell = ws.getCell(rowIdx, i + 1);
      let v = obj[c.key];
      if (v === undefined || v === '') v = null;
      if (v !== null) {
        if (['money', 'int', 'num', 'pct'].includes(c.type)) { v = Number(v); if (!Number.isFinite(v)) v = null; } else if (c.type === 'date' || c.type === 'datetime') {
          v = v instanceof Date ? v : null;
        } else v = textValue(v);
      }
      cell.value = v;
      if (FORMATS[c.type]) cell.numFmt = FORMATS[c.type];
      if (c.wrap) cell.alignment = { wrapText: true, vertical: 'top' };
      if (bold) { cell.font = { bold: true }; cell.fill = TOTAL_FILL; cell.border = { top: { style: 'thin', color: { argb: 'FF9AA7B6' } } }; }
      widths[i] = Math.max(widths[i], displayLen(v, c.type) + 2);
    });
  };
  let i = headerRow + 1;
  for (const row of def.rows) put(i++, row, false);
  if (def.totals) put(i++, def.totals, true);
  cols.forEach((c, k) => { ws.getColumn(k + 1).width = c.width || Math.min(60, widths[k]); });
  ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 0, topLeftCell: `A${headerRow + 1}`, activeCell: `A${headerRow + 1}` }];
  if (def.rows.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: cols.length } };
  return ws;
}

/** CSV rows (arrays) for the same table definition. */
function tableCsv(def) {
  const fmt = (v, c) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      const iso = v.toISOString();
      return c.type === 'date' ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
    }
    return v;
  };
  const out = [def.columns.map((c) => c.header)];
  for (const r of def.rows) out.push(def.columns.map((c) => fmt(r[c.key], c)));
  if (def.totals) out.push(def.columns.map((c) => fmt(def.totals[c.key], c)));
  return out;
}

async function send(res, wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${String(filename).replace(/[^\w.-]+/g, '_')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(buf));
}

// ---------------------------------------------------------------------------------------------
// Reading uploaded workbooks

/** A cell's plain value: formulas give their cached result, rich text its text, errors null. */
function cellValue(cell) {
  let v = cell && cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v || 'formula' in v || 'sharedFormula' in v) v = v.result === undefined ? null : v.result;
    else if (v.richText) v = v.richText.map((t) => t.text).join('');
    else if ('text' in v) v = v.text;
    else if ('error' in v) v = null;
    if (v && typeof v === 'object' && !(v instanceof Date)) v = ('error' in v) ? null : String(v);
  }
  if (typeof v === 'string') { v = v.replace(/ /g, ' ').trim(); if (v === '') return null; }
  return v;
}

const normHeader = (s) => String(s || '').replace(/ /g, ' ').replace(/\*+\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Rows of a sheet as objects keyed by normalised header. The header row is the first of the first 10
 * rows that contains `anchor` (a required header). Blank rows are skipped. Returns
 * { headerRow, headers: [{col, key, label}], rows: [{rowNumber, cells: {key: value}}] } or null when the anchor is missing.
 */
function readSheet(ws, anchor) {
  if (!ws) return null;
  let headerRow = 0;
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) if (normHeader(cellValue(row.getCell(c))) === anchor) { headerRow = r; break; }
    if (headerRow) break;
  }
  if (!headerRow) return null;
  const hr = ws.getRow(headerRow);
  const headers = [];
  for (let c = 1; c <= hr.cellCount; c++) {
    const label = cellValue(hr.getCell(c));
    if (label === null) continue;
    const raw = String(label).replace(/\*+\s*$/, '').trim();
    headers.push({ col: c, key: normHeader(raw), label: raw });
  }
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = {};
    let any = false;
    for (const h of headers) {
      const v = cellValue(row.getCell(h.col));
      cells[h.key] = v;
      if (v !== null) any = true;
    }
    if (any) rows.push({ rowNumber: r, cells });
  }
  return { headerRow, headers, rows };
}

/** "1,25,000" / "₹ 1,25,000.50" / 125000 -> number; NaN when not a number. */
function parseNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return NaN;
  const s = String(v).replace(/^(rs\.?|inr|₹)\s*/i, '').replace(/[,\s₹]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/**
 * Date and time typed in a sheet, read as IST: an Excel date cell, an Excel serial number, or text
 * "DD-MM-YYYY HH:mm", "DD/MM/YYYY HH:mm", "YYYY-MM-DD HH:mm" (time optional, 24-hour, or with am/pm).
 * Returns a Date or null.
 */
function parseDateIST(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : new Date(v.getTime() - IST_MS);
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    return new Date(Math.round((v - 25569) * 86400000) - IST_MS);
  }
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ t,]+(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*(am|pm)?)?$/);
  let y; let mo; let d; let h; let mi; let ap;
  if (m) [, d, mo, y, h, mi, ap] = m;
  else {
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?)?$/);
    if (!m) return null;
    [, y, mo, d, h, mi, ap] = m;
  }
  let hh = Number(h || 0);
  if (ap) { if (hh < 1 || hh > 12) return null; hh = (hh % 12) + (ap === 'pm' ? 12 : 0); }
  const parts = [Number(y), Number(mo), Number(d), hh, Number(mi || 0)];
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59) return null;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]) - IST_MS);
  // Reject 31-02-2026 and the like.
  const back = new Date(dt.getTime() + IST_MS);
  if (back.getUTCDate() !== parts[2] || back.getUTCMonth() !== parts[1] - 1) return null;
  return dt;
}

module.exports = {
  ExcelJS, workbook, addTable, tableCsv, send, toExcelDate, dateOnly, sheetName, textValue, nowText, FORMATS,
  cellValue, normHeader, readSheet, parseNumber, parseDateIST, IST_MS,
};
