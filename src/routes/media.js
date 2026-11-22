const express = require('express');
const db = require('../db');
const { wrap } = require('../middleware');

const router = express.Router();

/**
 * GET /media/:id            full-size image or document
 * GET /media/:id?size=thumb 640x480 thumbnail (images only)
 * Public only when the file belongs to a published auction (cover, lot photo, document) or is a
 * seller logo. Admins can see every file. Bidder KYC documents are never served from here.
 */
router.get('/media/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(404).end();
  if (!req.admin) {
    const ok = await db.one(
      `SELECT 1 FROM auctions a WHERE a.status = 'published' AND a.cover_id = $1
       UNION ALL SELECT 1 FROM lot_images li JOIN lots l ON l.id = li.lot_id JOIN auctions a ON a.id = l.auction_id
                  WHERE a.status = 'published' AND li.file_id = $1
       UNION ALL SELECT 1 FROM auction_documents d JOIN auctions a ON a.id = d.auction_id
                  WHERE a.status = 'published' AND d.file_id = $1
       UNION ALL SELECT 1 FROM sellers s WHERE s.logo_id = $1
       LIMIT 1`, [id]);
    if (!ok) return res.status(404).end();
  }
  const thumb = req.query.size === 'thumb';
  const f = await db.one(`SELECT filename, mime, ${thumb ? 'COALESCE(thumb, data)' : 'data'} AS data FROM files WHERE id = $1`, [id]);
  if (!f) return res.status(404).end();
  const isImg = f.mime.startsWith('image/');
  res.set('Content-Type', f.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `${isImg || f.mime === 'application/pdf' ? 'inline' : 'attachment'}; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`);
  // File ids are never reused and stored files are never modified, so they can be cached hard.
  res.set('Cache-Control', req.admin ? 'private, max-age=3600' : 'public, max-age=604800, immutable');
  res.send(f.data);
}));

module.exports = router;
