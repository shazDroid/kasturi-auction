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
