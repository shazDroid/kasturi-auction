-- Idempotent schema: runs on every boot.

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admins (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'staff' CHECK (role IN ('superadmin','staff')),
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id         serial PRIMARY KEY,
  filename   text NOT NULL,
  mime       text NOT NULL,
  size       integer NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             serial PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  name           text NOT NULL,
  phone          text NOT NULL DEFAULT '',
  company_name   text NOT NULL DEFAULT '',
  business_type  text NOT NULL DEFAULT '',
  gstin          text NOT NULL DEFAULT '',
  pan            text NOT NULL DEFAULT '',
  address        text NOT NULL DEFAULT '',
  city           text NOT NULL DEFAULT '',
  state          text NOT NULL DEFAULT '',
  pincode        text NOT NULL DEFAULT '',
  email_verified boolean NOT NULL DEFAULT false,
  verify_token   text,
  reset_token    text,
  reset_expires  timestamptz,
  -- incomplete: profile/documents not submitted; pending: awaiting admin review
  kyc_status     text NOT NULL DEFAULT 'incomplete' CHECK (kyc_status IN ('incomplete','pending','approved','rejected')),
  kyc_note       text NOT NULL DEFAULT '',
  kyc_submitted_at timestamptz,
  blocked        boolean NOT NULL DEFAULT false,
  fee_paid_until timestamptz,
  email_opt_out  boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_documents (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type   text NOT NULL,
  file_id    integer NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_documents_user ON user_documents(user_id);

CREATE TABLE IF NOT EXISTS sellers (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  location    text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  contact_name  text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auctions (
  id                serial PRIMARY KEY,
  title             text NOT NULL,
  seller_id         integer REFERENCES sellers(id) ON DELETE SET NULL,
  category          text NOT NULL DEFAULT '',
  location          text NOT NULL DEFAULT '',
  description       text NOT NULL DEFAULT '',
  inspection        text NOT NULL DEFAULT '',
  terms             text NOT NULL DEFAULT '',
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  -- a bid placed within extend_window_min of a lot's close pushes the close out by extend_by_min
  extend_window_min integer NOT NULL DEFAULT 3,
  extend_by_min     integer NOT NULL DEFAULT 3,
  -- lot N closes stagger_min * (N-1) minutes after ends_at
  stagger_min       integer NOT NULL DEFAULT 0,
  show_highest_bid  boolean NOT NULL DEFAULT true,
  auto_award        boolean NOT NULL DEFAULT false,
  reminder_sent     boolean NOT NULL DEFAULT false,
  announced_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS auctions_starts ON auctions(starts_at);

CREATE TABLE IF NOT EXISTS lots (
  id             serial PRIMARY KEY,
  auction_id     integer NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  lot_no         integer NOT NULL,
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  quantity       numeric(14,3) NOT NULL DEFAULT 1,
  unit           text NOT NULL DEFAULT 'MT',
  start_price    numeric(14,2) NOT NULL,
  increment      numeric(14,2) NOT NULL DEFAULT 100,
  reserve_price  numeric(14,2),
  image_id       integer REFERENCES files(id) ON DELETE SET NULL,
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  -- set when the lot closes: pending (awaiting seller/admin decision), awarded, rejected, no_bids
  result         text CHECK (result IN ('pending','awarded','rejected','no_bids')),
  winning_bid_id integer,
  result_note    text NOT NULL DEFAULT '',
  UNIQUE (auction_id, lot_no)
);
CREATE INDEX IF NOT EXISTS lots_open_ends ON lots(ends_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS bids (
  id         bigserial PRIMARY KEY,
  lot_id     integer NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     numeric(14,2) NOT NULL,
  ip         text NOT NULL DEFAULT '',
  cancelled  boolean NOT NULL DEFAULT false,
  cancel_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bids_lot_amount ON bids(lot_id, amount DESC) WHERE NOT cancelled;
CREATE INDEX IF NOT EXISTS bids_user ON bids(user_id);

CREATE TABLE IF NOT EXISTS payments (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       text NOT NULL DEFAULT 'registration_fee',
  base_amount   numeric(14,2) NOT NULL,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  amount        numeric(14,2) NOT NULL,
  currency      text NOT NULL DEFAULT 'INR',
  method        text NOT NULL DEFAULT 'razorpay' CHECK (method IN ('razorpay','offline')),
  status        text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','refunded')),
  rp_order_id   text UNIQUE,
  rp_payment_id text,
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);

CREATE TABLE IF NOT EXISTS email_templates (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  variables   text NOT NULL DEFAULT '',
  subject     text NOT NULL,
  body        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_log (
  id           bigserial PRIMARY KEY,
  to_email     text NOT NULL,
  subject      text NOT NULL,
  html         text NOT NULL,
  template_key text,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  error        text NOT NULL DEFAULT '',
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX IF NOT EXISTS email_log_queue ON email_log(id) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS pages (
  slug       text PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enquiries (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL,
  phone      text NOT NULL DEFAULT '',
  company    text NOT NULL DEFAULT '',
  message    text NOT NULL,
  handled    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  admin_id   integer REFERENCES admins(id) ON DELETE SET NULL,
  action     text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- v2: images, documents, lot specifications ----------
ALTER TABLE files    ADD COLUMN IF NOT EXISTS thumb  bytea;
ALTER TABLE files    ADD COLUMN IF NOT EXISTS width  integer;
ALTER TABLE files    ADD COLUMN IF NOT EXISTS height integer;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS cover_id integer REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE sellers  ADD COLUMN IF NOT EXISTS logo_id  integer REFERENCES files(id) ON DELETE SET NULL;
-- [{ "label": "Grade", "value": "EN8" }, ...]
ALTER TABLE lots     ADD COLUMN IF NOT EXISTS specs jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS lot_images (
  id         serial PRIMARY KEY,
  lot_id     integer NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  file_id    integer NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lot_images_lot ON lot_images(lot_id, sort_order, id);

CREATE TABLE IF NOT EXISTS auction_documents (
  id         serial PRIMARY KEY,
  auction_id integer NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  file_id    integer NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  title      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auction_documents_auction ON auction_documents(auction_id);

-- v1 kept a single photo per lot in lots.image_id; carry those into the gallery once.
INSERT INTO lot_images(lot_id, file_id)
SELECT l.id, l.image_id FROM lots l
 WHERE l.image_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lot_images li WHERE li.lot_id = l.id);

-- ---------- v3: bidder groups, restricted auctions, sign-up codes, auto-bids, watchlist, sale orders ----------
CREATE TABLE IF NOT EXISTS bidder_groups (
  id                 serial PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  description        text NOT NULL DEFAULT '',
  -- NULL means "use the default registration fee from Settings"
  fee_amount         numeric(14,2),
  -- NULL means "use the default buyer's commission from Settings"
  commission_percent numeric(6,2),
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS group_id integer REFERENCES bidder_groups(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS invite_codes (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  label      text NOT NULL DEFAULT '',          -- who it was issued to, for the admin's reference
  group_id   integer REFERENCES bidder_groups(id) ON DELETE SET NULL,  -- bidders who sign up with it join this group
  max_uses   integer NOT NULL DEFAULT 1,
  used_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code_id integer REFERENCES invite_codes(id) ON DELETE SET NULL;

-- 'public': everyone. 'restricted': only bidders in auction_groups or auction_invites (and admins).
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS watch_alert_sent boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS auction_groups (
  auction_id integer NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  group_id   integer NOT NULL REFERENCES bidder_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (auction_id, group_id)
);
CREATE TABLE IF NOT EXISTS auction_invites (
  auction_id integer NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (auction_id, user_id)
);

-- Additional auction photos. auctions.cover_id always points at the first one (kept in sync by the admin code).
CREATE TABLE IF NOT EXISTS auction_images (
  id         serial PRIMARY KEY,
  auction_id integer NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  file_id    integer NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auction_images_auction ON auction_images(auction_id, sort_order, id);
INSERT INTO auction_images(auction_id, file_id)
SELECT a.id, a.cover_id FROM auctions a
 WHERE a.cover_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auction_images ai WHERE ai.auction_id = a.id);

-- A lot can open at a different start price for a bidder group.
CREATE TABLE IF NOT EXISTS lot_group_prices (
  lot_id      integer NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  group_id    integer NOT NULL REFERENCES bidder_groups(id) ON DELETE CASCADE,
  start_price numeric(14,2) NOT NULL,
  PRIMARY KEY (lot_id, group_id)
);

-- Auto-bidding: the system bids for the bidder, one increment at a time, up to max_amount.
CREATE TABLE IF NOT EXISTS proxy_bids (
  id         serial PRIMARY KEY,
  lot_id     integer NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_amount numeric(14,2) NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lot_id, user_id)
);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS auto boolean NOT NULL DEFAULT false;  -- placed by auto-bidding

-- Buyer's commission percentage fixed at the moment a lot is awarded.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS commission_percent numeric(6,2);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auction_id integer NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, auction_id)
);

CREATE TABLE IF NOT EXISTS sale_orders (
  id         serial PRIMARY KEY,
  number     text NOT NULL UNIQUE,              -- e.g. KA/SO/2026/0001
  lot_id     integer NOT NULL UNIQUE REFERENCES lots(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- everything printed on the document, frozen when it was issued
  snapshot   jsonb NOT NULL,
  issued_by  integer REFERENCES admins(id) ON DELETE SET NULL,
  issued_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- v3 billing ----------
-- kind: registration_fee (raised automatically when a fee is paid), commission (buyer's commission on an
-- awarded lot), other (raised by hand). Sale orders are award documents, not invoices: the material itself
-- is invoiced by the seller.
CREATE TABLE IF NOT EXISTS invoices (
  id          serial PRIMARY KEY,
  number      text NOT NULL UNIQUE,             -- e.g. KA/INV/2026-27/0001
  kind        text NOT NULL,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id      integer REFERENCES lots(id) ON DELETE SET NULL,
  payment_id  integer REFERENCES payments(id) ON DELETE SET NULL,
  -- bill-to details, line items [{description, hsn_sac, qty, unit, rate, amount}], tax lines: frozen at issue
  snapshot    jsonb NOT NULL,
  subtotal    numeric(14,2) NOT NULL,
  tax         numeric(14,2) NOT NULL DEFAULT 0,
  total       numeric(14,2) NOT NULL,
  status      text NOT NULL DEFAULT 'unpaid',   -- unpaid | part_paid | paid | cancelled
  issued_at   timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz,
  issued_by   integer REFERENCES admins(id) ON DELETE SET NULL,
  cancel_note text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS invoices_user ON invoices(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_per_payment ON invoices(payment_id) WHERE payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_payments (
  id          serial PRIMARY KEY,
  invoice_id  integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount      numeric(14,2) NOT NULL,
  method      text NOT NULL DEFAULT 'bank_transfer',  -- bank_transfer | upi | cheque | cash | razorpay | adjustment
  reference   text NOT NULL DEFAULT '',
  paid_on     date NOT NULL DEFAULT CURRENT_DATE,
  note        text NOT NULL DEFAULT '',
  recorded_by integer REFERENCES admins(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Settlement of an awarded lot between buyer and seller, tracked by the admin.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS buyer_paid_at timestamptz;   -- buyer's payment for the material confirmed
ALTER TABLE lots ADD COLUMN IF NOT EXISTS lifted_at     timestamptz;   -- material collected
ALTER TABLE lots ADD COLUMN IF NOT EXISTS settlement_note text NOT NULL DEFAULT '';
