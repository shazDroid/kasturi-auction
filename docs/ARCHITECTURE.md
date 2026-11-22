# Kasturi Auction: architecture and build contract

B2B forward e-auction platform (industrial scrap and surplus lots, India, INR, IST), modelled on steelez.com.
Node 20+, Express 4, EJS, PostgreSQL, Socket.IO. No build step. Deployed on Render.

## Already written (read these before coding; do not change their exports)
- `src/schema.sql` : full schema. Read it. All tables/columns you need exist.
- `src/db.js` : `query(sql, params)`, `one()` (row|null), `many()` (rows), `tx(async client => ...)`. numeric columns arrive as JS numbers.
- `src/lib/util.js` : `fmtINR fmtNum fmtDate fmtTime fmtDT fmtDay toLocalInput parseLocal token bidderNo escapeHtml nl2p isEmail clean toInt toMoney toCsv`. All are also available in every view as locals.
- `src/lib/settings.js` : `DEFS` (every admin option), `get(key) bool(key) num(key) list(key) all() save(values) load()`.
- `src/lib/bidding.js` : `PHASE_SQL` (needs auctions alias `a`; yields draft|cancelled|upcoming|live|closed), `eligibility(user)`, `auctionState(auctionId, userId)`, `placeBid({userId, lotId, amount, ip})` (throws `BidError`), `decideLot(lotId, 'awarded'|'rejected', note)`, `cancelBid(bidId, note)`, `recalcLotEnds(auctionId)`, `broadcastLot(auctionId, lotId)`, `closeDueLots()`.
- `src/lib/payments.js` : `feeQuote() feeActive(user) createFeeOrder(user) markPaidByOrder(orderId, paymentId) recordOffline(userId, note) revokeFee(userId) validUntilText(date)`.
- `src/lib/worker.js` : background loops; `mailAuction(templateKey, auctionId)` emails all bidders; `audience()`.
- `src/middleware.js` : `wrap(asyncHandler)`, `requireUser requireAdmin requireSuperadmin`, `audit(req, action, detail)`, `upload` (multer, memory, 5 MB, pdf/jpg/png/webp), `saveFile(multerFile) -> fileId`, `sendFile(res, fileId, {inline})`. Also sets `req.user`, `req.admin`, `req.flash(type, text)` with type `ok|error|info`, `res.page(view, data)` (site layout) and `res.adminPage(view, data)` (admin layout).
- `src/server.js` : mounts `routes/webhook`, `/admin` -> `routes/admin`, then `routes/auth`, `routes/account`, `routes/site`. Each route file exports an `express.Router()`.
- `src/views/layout.ejs`, `src/views/admin/layout.ejs`, `src/views/error.ejs`, `src/views/partials/flash.ejs`.
- `public/css/app.css` : the whole design system. `public/js/site.js` : countdowns (`<span class="countdown" data-countdown="EPOCH_MS" data-done="Closed">`), `data-toggle`, `data-confirm="Question?"` on submit buttons/links, `KA.toast(text, 'good'|'bad')`, `KA.inr(n)`, `KA.now()`, `KA.setServerNow(ms)`, `KA.fmtLeft(ms)`.

## Interfaces being written in parallel (code against these exactly)
`src/lib/mailer.js`
- `send(templateKey, toEmail, vars) -> Promise` queues an email from an admin-editable template (no-op if the template is disabled).
- `sendRaw(toEmail, subject, innerHtml, templateKey?)` queues a custom email; innerHtml is wrapped in the standard layout.
- `notifyAdmin(templateKey, vars)` sends to the `admin_notify_email` setting if set.
- `render(templateKey, vars) -> Promise<{subject, html} | null>`; `renderString(subject, body, vars) -> {subject, html}` for previews.
- `url(path) -> absolute URL`; `processQueue()`; `transportName() -> 'brevo'|'smtp'|'none'`; `DEFAULT_TEMPLATES` (array of {key,name,description,variables,subject,body}).
- Template keys and their vars: `verify_email(name, verify_url)`, `welcome(name, account_url)`, `password_reset(name, reset_url)`, `kyc_submitted_admin(bidder_name, company, bidder_no, admin_url)`, `kyc_approved(name, account_url)`, `kyc_rejected(name, reason, account_url)`, `fee_receipt(name, company, base_amount, tax_amount, amount, payment_ref, paid_on, valid_until)`, `fee_paid_admin(bidder_name, company, amount, payment_ref)`, `auction_announcement` and `auction_reminder` `(name, auction_title, seller_name, location, starts_at, ends_at, lot_count, auction_url)`, `outbid(name, auction_title, lot_no, lot_title, your_bid, auction_url)`, `lot_won(name, auction_title, lot_no, lot_title, quantity, winning_bid, account_url)`, `enquiry_ack(name, message)`, `enquiry_admin(name, email, phone, company, message)`. Always available: `site_name, site_url, contact_email, contact_phone`.

`src/lib/razorpay.js`
- `configured() -> bool`, `createOrder({amountPaise, receipt, notes}) -> {id, amount, currency}`, `verifyCheckout({orderId, paymentId, signature}) -> bool`, `verifyWebhook(rawBodyBuffer, signatureHeader) -> bool`.

## Rules for all code
- Every async route handler is wrapped: `router.get('/x', wrap(async (req, res) => {...}))`.
- SQL is always parameterised. Never interpolate request data into SQL.
- CSRF: every POST form includes `<input type="hidden" name="_csrf" value="<%= csrf %>">`. Multipart forms cannot (body is parsed after the check) so they put it in the URL: `action="/path?_csrf=<%= csrf %>"`. fetch() sends header `x-csrf-token` read from `<meta name="csrf-token">`.
- CSP forbids inline `<script>` and inline event handlers (onclick etc). Put JS in `public/js/*.js` and pass `scripts: ['/js/file.js']` to `res.page`/`res.adminPage`. Pass data via `data-*` attributes. Inline `style=""` attributes are allowed but avoid them; use the CSS classes.
- Views: always escape with `<%= %>`. Only use `<%- %>` for trusted HTML (CMS page bodies written by admins, `nl2p()` output, includes).
- Pass `title` to every page. For money use `fmtINR`, dates `fmtDT`/`fmtDate`; times are always IST. Admin datetime inputs are `<input type="datetime-local" value="<%= toLocalInput(d) %>">` parsed with `parseLocal()`.
- Other bidders' identities are never sent to a bidder (no names, no ids). Admin sees everything.
- After a POST always redirect (PRG) with a `req.flash` message.
- Validate and trim all input (`clean`, `toInt`, `toMoney`, `isEmail`). Passwords: bcryptjs, cost 11, min 8 chars.

## UI rules (the client wants a professional business UI with zero "AI template" look)
- Use the classes in `public/css/app.css`; read it fully first. You may append small additions to the END of app.css under a comment with your area name, but reuse existing tokens and do not restyle existing classes.
- Data goes in `.table-wrap > table.table` (add `.table-stack` + `data-label` on cells for mobile). Do not turn lists into grids of cards. No icons libraries, no emoji, no gradients, no shadows, no rounded pills, no all-caps labels, no "eyebrow" labels above headings, no arrows appended to links, no middle-dot separated meta strings, no decorative stats.
- Left aligned. Page starts with `.page-head` (h1 and optionally one plain sentence). Sentence case everywhere.
- Copy: plain, specific, active voice, written for a scrap trader or a plant stores manager. Buttons say what they do ("Place bid", "Save auction", "Approve bidder"). Empty states say what to do next (`.empty`). Errors say what went wrong and how to fix it. No marketing fluff, no exclamation marks.
- Status uses `.tag` variants: `tag-live`, `tag-upcoming`, `tag-ok`, `tag-warn`, `tag-bad`, plain `tag` for closed/draft.

## Version 2 additions (images, documents, rich text, specifications)
Already in place:
- Schema (see the v2 block at the end of `src/schema.sql`): `files.thumb/width/height`, `auctions.cover_id`, `sellers.logo_id`, `lots.specs` (jsonb array of `{label, value}`), `lot_images(lot_id, file_id, sort_order)`, `auction_documents(auction_id, file_id, title)`. `lots.image_id` is legacy: do not read or write it any more; a lot's cover is its first `lot_images` row (ORDER BY sort_order, id).
- `src/middleware.js`: `saveImage(multerFile) -> fileId` (auto-rotate, max 1800px, WebP, plus a 640x480 thumbnail), `isImage(file)`, `saveFile` (for PDFs), upload limit 8 MB, up to 12 files (`upload.array('images', 12)`).
- `src/routes/media.js`: `GET /media/:fileId` and `GET /media/:fileId?size=thumb`. Public for files attached to published auctions (cover, lot photos, documents) and seller logos; admins can open any file. Use these URLs everywhere for photos and documents.
- `src/lib/rich.js`: `sanitize(html)` (run on editor HTML before saving), `render(value)` and `excerpt(value, max)`. Views get them as locals: `<%- rich(auction.description) %>` (handles both editor HTML and old plain text) and `<%= excerpt(lot.description, 140) %>`. Wrap rendered rich text in an element with class `rich`.
- Quill 2 is served at `/vendor/quill/quill.js` and `/vendor/quill/quill.snow.css` (CSP allows only same-origin scripts, so never use a CDN).
- Both layouts accept `styles: ['/css/x.css']` as well as `scripts: [...]`.
- Rich text fields: `auctions.description`, `auctions.inspection`, `auctions.terms`, `lots.description`. They now hold sanitised editor HTML (older rows hold plain text).
