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

## Version 3 additions (groups, restricted auctions, sign-up codes, auto-bidding, watchlist, billing, Excel)
Already in place and tested (do not change these files' behaviour; read them):
- Schema: the two v3 blocks at the end of `src/schema.sql`: `bidder_groups` (fee_amount, commission_percent; NULL = use the default from Settings), `users.group_id`, `users.invite_code_id`, `invite_codes`, `auctions.visibility` ('public' | 'restricted'), `auction_groups`, `auction_invites`, `auction_images` (extra auction photos; `auctions.cover_id` must always equal the first auction_images row by sort_order, id, or NULL when there are none), `lot_group_prices`, `proxy_bids`, `bids.auto`, `lots.commission_percent` (frozen when a lot is awarded), `watchlist`, `sale_orders`, `invoices`, `invoice_payments`, `lots.buyer_paid_at / lifted_at / settlement_note`.
- Settings (`src/lib/settings.js` DEFS; the admin Settings page renders them automatically): `require_invite_code`, `proxy_bidding_enabled`, `default_commission_percent`, `watch_alert_minutes`, and the "Billing and sale orders" group (`company_legal_name`, `company_gstin`, `company_state`, `sale_order_prefix`, `invoice_prefix`, `commission_gst_percent`, `invoice_sac`, `invoice_due_days`, `bank_details`, `sale_order_terms`).
- `src/lib/bidding.js`:
  - `visibleSql(n)`: SQL condition on auctions alias `a` for "bidder $n may see this auction" (bind 0 for visitors). EVERY public query that lists or loads auctions/lots must include it. `canSee(auctionId, userId)`.
  - `auctionState()` now returns per lot: `startPrice` (the viewer's group price), `minBid`, `myBid`, `myMax` (the viewer's active auto-bid maximum or null), `leading`, `won`.
  - `placeBid()` returns `{bidId, extended, leading}` (leading false = another bidder's auto-bid immediately beat it). `setProxy({userId, lotId, maxAmount})` -> `{extended, leading, max}`, `cancelProxy({userId, lotId})`. Both throw `BidError`.
  - `startPriceFor(q, lot, groupId)`, `commissionFor(q, userId)`.
- `src/lib/payments.js`: `feeQuoteFor(userId)` (async; includes the bidder's group fee and `groupName`); use it wherever a specific bidder's fee is shown. `feeQuote()` is the default fee only.
- `src/lib/worker.js`: `audience(auctionId)` respects restricted auctions; watchers get template `watch_alert` before start.
- `src/routes/media.js`: serves auction_images too and hides files of restricted auctions from bidders who cannot see them.
- `src/routes/admin.js` mounts `src/routes/admin/{groups,codes,billing,reports,excel}.js` automatically when the file exists. The admin sidebar already links: /admin/excel, /admin/groups, /admin/codes, /admin/billing/sale-orders, /admin/billing/invoices, /admin/reports.
- npm packages installed: `pdfkit`, `exceljs` (plus sharp, sanitize-html, quill).

Interfaces being written in parallel (code against these exactly):
`src/lib/billing.js`
- `invoiceForFeePayment(paymentId)`: idempotent; raises a paid tax invoice for a paid registration fee (called automatically by payments.js).
- `issueSaleOrder(lotId, adminId) -> saleOrder row` (lot must be awarded; idempotent per lot), `issueCommissionInvoice(lotId, adminId) -> invoice row | null` (null when the commission is 0).
- `saleOrderPdf(saleOrderId) -> Promise<Buffer>`, `invoicePdf(invoiceId) -> Promise<Buffer>`.
- `listForUser(userId) -> Promise<{ saleOrders: [...], invoices: [...] }>` (rows include id, number, issued_at, totals, status, lot/auction titles).
New email templates (in mailer DEFAULT_TEMPLATES): `watch_alert(name, auction_title, location, starts_at, ends_at, minutes, auction_url)`, `invite_code(name, company, code, register_url, expires_on, group_name)`, `sale_order_issued(name, number, auction_title, lot_no, lot_title, amount, billing_url)`, `invoice_issued(name, number, description, total, due_on, billing_url)`.
Bidder URLs: `/account/billing` (sale orders and invoices with PDF downloads at `/account/billing/sale-orders/:id.pdf` and `/account/billing/invoices/:id.pdf`), `/account/watchlist`, `POST /auctions/:id/watch` and `/unwatch`, `POST /lots/:id/autobid` (JSON {max}) and `/autobid/cancel`. Registration accepts an `invite_code` field. Admins can open unpublished auctions on the public URLs as a preview (`/auctions/:id`, `/auctions/:auctionId/lots/:lotId`).
