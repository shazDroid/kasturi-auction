// Shared helpers for admin forms that take uploads, rich text and specifications.
const db = require('../../db');
const rich = require('../../lib/rich');
const { clean } = require('../../lib/util');
const mw = require('../../middleware');

const MAX_PHOTOS = 12;
const RICH_MAX = 100000;
const SPEC_ROWS = 30;
const SPEC_LABEL_MAX = 80;
const SPEC_VALUE_MAX = 300;
const SPEC_LABELS = ['Grade', 'Thickness', 'Size', 'Condition', 'Make', 'Model', 'Year', 'Packing', 'Loading'];

/** Assets for pages with a rich text editor. admin-extra.css comes last so its overrides win. */
const EDITOR_ASSETS = {
  styles: ['/vendor/quill/quill.snow.css', '/css/admin-extra.css'],
  scripts: ['/vendor/quill/quill.js', '/js/editor.js', '/js/admin.js'],
};

/**
 * Run a multer middleware but keep its errors on req.uploadError (a sentence for the user)
 * instead of passing them to the global error handler.
 */
function uploads(multerMw) {
  return (req, res, next) => multerMw(req, res, (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE'
        ? `${err.filename ? `"${err.filename}"` : 'A file'} is larger than 8 MB. Choose a smaller file or reduce the photo size and try again.`
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Choose at most ${MAX_PHOTOS} files at a time.`
          : 'The upload could not be read. Try again, and choose JPG, PNG, WebP or PDF files only.';
    }
    req.body = req.body || {};
    next();
  });
}

/** Names of files multer skipped for this field because of their type. */
const rejectedNames = (req, field) => (req.rejectedUploads || []).filter((f) => f.field === field).map((f) => `"${f.name}"`);

/**
 * Store an uploaded photo. Returns { id } or { error } with a sentence for the user.
 */
async function storeImage(file) {
  if (!mw.isImage(file)) return { error: `"${file.originalname}" is not a photo. Upload JPG, PNG or WebP images.` };
  try {
    return { id: await mw.saveImage(file) };
  } catch (e) {
    return { error: `"${file.originalname}" could not be read as a photo. It may be damaged; save it again as JPG and retry.` };
  }
}

/** Validate photos chosen in one field. Returns an error sentence or ''. */
function checkPhotos(req, field, files) {
  const bad = rejectedNames(req, field);
  if (bad.length) return `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a JPG, PNG or WebP photo. Remove ${bad.length === 1 ? 'it' : 'them'} and try again.`;
  const pdf = files.filter((f) => !mw.isImage(f)).map((f) => `"${f.originalname}"`);
  if (pdf.length) return `${pdf.join(', ')} ${pdf.length === 1 ? 'is' : 'are'} not a photo. PDFs cannot be used as photos; add them as auction documents instead.`;
  return '';
}

/**
 * Store several photos. On any failure the photos stored so far are deleted again.
 * Returns { ids } or { error }.
 */
async function storeImages(files) {
  const ids = [];
  for (const f of files) {
    const r = await storeImage(f);
    if (r.error) {
      await deleteFilesIfUnused(ids);
      return { error: r.error };
    }
    ids.push(r.id);
  }
  return { ids };
}

/**
 * Delete files rows that nothing refers to any more. Older data can share one file between lots
 * (v1 duplicated lot photos by reference), so every reference is checked before deleting.
 */
async function deleteFilesIfUnused(ids) {
  const list = [...new Set((ids || []).filter((x) => Number.isInteger(Number(x)) && x !== null).map(Number))];
  if (!list.length) return 0;
  const r = await db.query(
    `DELETE FROM files f WHERE f.id = ANY($1::int[])
        AND NOT EXISTS (SELECT 1 FROM lot_images li WHERE li.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.cover_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM sellers s WHERE s.logo_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM auction_documents d WHERE d.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM user_documents u WHERE u.file_id = f.id)`, [list]
  );
  return r.rowCount;
}

/**
 * Read one rich text field from the editor: checks the size, then sanitises.
 * Adds a message to errors[key] when it is too long.
 */
function readRich(body, key, label, errors) {
  const raw = String((body && body[key]) || '');
  if (raw.length > RICH_MAX) {
    errors[key] = `${label} is too long (${raw.length.toLocaleString('en-IN')} characters including formatting). Shorten it to under ${RICH_MAX.toLocaleString('en-IN')} characters, or upload long annexures as a PDF document.`;
  }
  // Quill 2.0.3 emits every space as &nbsp;; store plain spaces.
  return rich.sanitize(raw.slice(0, RICH_MAX * 2).replace(/&nbsp;|\u00a0/g, ' '));
}

/** Specification rows from spec_label / spec_value (arrays when repeated). Returns { specs, rows, error }. */
function readSpecs(body) {
  const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
  const labels = arr(body.spec_label);
  const values = arr(body.spec_value);
  const n = Math.max(labels.length, values.length);
  const specs = [];
  const rows = [];
  let half = false;
  for (let i = 0; i < n; i++) {
    const label = clean(labels[i], SPEC_LABEL_MAX).replace(/\s+/g, ' ');
    const value = clean(values[i], SPEC_VALUE_MAX).replace(/\s+/g, ' ');
    if (!label && !value) continue;
    rows.push({ label, value });
    if (!label || !value) { half = true; continue; }
    specs.push({ label, value });
  }
  let error = '';
  if (half) error = 'Fill in both the label and the value of each specification row, or clear the row.';
  else if (specs.length > SPEC_ROWS) error = `Enter at most ${SPEC_ROWS} specification rows. Combine minor details into the description.`;
  return { specs: specs.slice(0, SPEC_ROWS), rows, error };
}

/** Photos of a lot in display order; the first one is the cover. */
const lotPhotos = (lotId) => db.many(
  `SELECT li.id, li.file_id, li.sort_order, f.filename, f.size, f.width, f.height
     FROM lot_images li JOIN files f ON f.id = li.file_id
    WHERE li.lot_id = $1 ORDER BY li.sort_order, li.id`, [lotId]
);

module.exports = {
  MAX_PHOTOS, RICH_MAX, SPEC_ROWS, SPEC_LABEL_MAX, SPEC_VALUE_MAX, SPEC_LABELS, EDITOR_ASSETS,
  uploads, rejectedNames, storeImage, storeImages, checkPhotos, deleteFilesIfUnused, readRich, readSpecs, lotPhotos,
};
