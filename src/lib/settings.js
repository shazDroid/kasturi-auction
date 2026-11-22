const db = require('../db');

/**
 * Every admin-controllable option. The admin Settings page renders itself from this list,
 * so adding an entry here is all it takes to add a new option.
 * type: text | textarea | number | bool | email
 */
const DEFS = [
  { group: 'Business details', key: 'site_name', label: 'Site name', type: 'text', def: 'Kasturi Auction' },
  { group: 'Business details', key: 'tagline', label: 'Homepage headline', type: 'text', def: 'Industrial scrap and surplus, sold by open online bidding' },
  { group: 'Business details', key: 'contact_email', label: 'Contact email', type: 'email', def: 'support@example.com' },
  { group: 'Business details', key: 'contact_phone', label: 'Contact phone', type: 'text', def: '' },
  { group: 'Business details', key: 'contact_address', label: 'Office address', type: 'textarea', def: '' },
  { group: 'Business details', key: 'support_hours', label: 'Support hours', type: 'text', def: 'Monday to Saturday, 10 am to 6 pm' },
  { group: 'Business details', key: 'announcement', label: 'Announcement bar', type: 'text', def: '', help: 'Shown at the top of every public page. Leave empty to hide.' },

  { group: 'Bidder registration', key: 'registration_open', label: 'Accept new registrations', type: 'bool', def: '1' },
  { group: 'Bidder registration', key: 'require_email_verification', label: 'Bidders must verify their email before bidding', type: 'bool', def: '1' },
  { group: 'Bidder registration', key: 'require_kyc_approval', label: 'Bidders need document approval before bidding', type: 'bool', def: '1' },
  { group: 'Bidder registration', key: 'required_documents', label: 'Documents to collect', type: 'text', def: 'GST certificate, PAN card, Address proof', help: 'Comma separated. Each becomes an upload slot on the bidder verification page.' },
  { group: 'Bidder registration', key: 'business_types', label: 'Business types offered at sign-up', type: 'text', def: 'Trader, Recycler, End user, Manufacturer, Other', help: 'Comma separated.' },

  { group: 'Bidder registration', key: 'require_invite_code', label: 'Businesses need a sign-up code to register', type: 'bool', def: '1', help: 'Generate codes under Bidders, Sign-up codes. Without a valid code the registration form is refused.' },

  { group: 'Registration fee', key: 'fee_enabled', label: 'Charge a registration fee before bidding', type: 'bool', def: '1' },
  { group: 'Registration fee', key: 'fee_amount', label: 'Fee amount (₹, before GST)', type: 'number', def: '5000' },
  { group: 'Registration fee', key: 'fee_gst_percent', label: 'GST on fee (%)', type: 'number', def: '18' },
  { group: 'Registration fee', key: 'fee_validity_days', label: 'Fee validity (days)', type: 'number', def: '365', help: '0 means the fee is paid once and never expires.' },

  { group: 'Bidding rules', key: 'default_extend_window_min', label: 'Default auto-extend window (minutes)', type: 'number', def: '3', help: 'A bid in the last N minutes extends the lot. Each auction can override this.' },
  { group: 'Bidding rules', key: 'default_extend_by_min', label: 'Default extension length (minutes)', type: 'number', def: '3' },
  { group: 'Bidding rules', key: 'default_increment', label: 'Default bid increment (₹)', type: 'number', def: '100' },
  { group: 'Bidding rules', key: 'max_bid_jump_percent', label: 'Largest single jump above the minimum bid (%)', type: 'number', def: '50', help: 'Blocks typing mistakes such as an extra zero. 0 turns the check off.' },
  { group: 'Bidding rules', key: 'catalogue_public', label: 'Show lots and prices to visitors who are not signed in', type: 'bool', def: '1' },

  { group: 'Bidding rules', key: 'proxy_bidding_enabled', label: 'Allow auto-bidding (bidder sets a maximum and the system bids for them)', type: 'bool', def: '1' },
  { group: 'Bidding rules', key: 'default_commission_percent', label: "Default buyer's commission (%)", type: 'number', def: '0', help: 'Added on top of the winning amount. A bidder group can have its own rate.' },

  { group: 'Billing and sale orders', key: 'company_legal_name', label: 'Company name printed on sale orders', type: 'text', def: 'Kasturi Auction' },
  { group: 'Billing and sale orders', key: 'company_gstin', label: 'Company GSTIN', type: 'text', def: '' },
  { group: 'Billing and sale orders', key: 'sale_order_prefix', label: 'Sale order number prefix', type: 'text', def: 'KA/SO' },
  { group: 'Billing and sale orders', key: 'invoice_prefix', label: 'Invoice number prefix', type: 'text', def: 'KA/INV' },
  { group: 'Billing and sale orders', key: 'company_state', label: 'Company state (decides CGST+SGST or IGST on invoices)', type: 'text', def: 'Maharashtra' },
  { group: 'Billing and sale orders', key: 'commission_gst_percent', label: "GST on buyer's commission (%)", type: 'number', def: '18' },
  { group: 'Billing and sale orders', key: 'invoice_sac', label: 'SAC code printed on service invoices', type: 'text', def: '998599' },
  { group: 'Billing and sale orders', key: 'invoice_due_days', label: 'Invoice payment terms (days)', type: 'number', def: '7' },
  { group: 'Billing and sale orders', key: 'bank_details', label: 'Payment instructions / bank details', type: 'textarea', def: '' },
  { group: 'Billing and sale orders', key: 'sale_order_terms', label: 'Standard terms printed on every sale order', type: 'textarea', def: 'Payment is due within 3 working days of this sale order. Material must be lifted within the period given in the auction terms. Weighment at the seller\'s weighbridge is final.' },

  { group: 'Email', key: 'mail_from_name', label: 'Sender name', type: 'text', def: 'Kasturi Auction' },
  { group: 'Email', key: 'mail_from_email', label: 'Sender email', type: 'email', def: 'no-reply@example.com', help: 'Must be an address your mail provider lets you send from.' },
  { group: 'Email', key: 'admin_notify_email', label: 'Send admin alerts to', type: 'email', def: '', help: 'New document submissions, payments and enquiries.' },
  { group: 'Email', key: 'reminder_minutes_before', label: 'Auction reminder lead time (minutes)', type: 'number', def: '60', help: '0 turns reminders off.' },
  { group: 'Email', key: 'watch_alert_minutes', label: 'Watchlist alert lead time (minutes)', type: 'number', def: '15', help: 'Bidders watching an auction get an email this long before it starts. 0 turns it off.' },
  { group: 'Email', key: 'email_footer', label: 'Email footer text', type: 'textarea', def: 'You are receiving this email because you have an account with us.' },

  { group: 'Maintenance', key: 'maintenance_mode', label: 'Close the public site for maintenance', type: 'bool', def: '0', help: 'The admin panel stays available.' },
  { group: 'Maintenance', key: 'maintenance_message', label: 'Maintenance message', type: 'text', def: 'We are carrying out scheduled maintenance. Please check back shortly.' },
];

let cache = null;

async function load() {
  const rows = await db.many('SELECT key, value FROM settings');
  const map = Object.fromEntries(DEFS.map((d) => [d.key, d.def]));
  for (const r of rows) map[r.key] = r.value;
  cache = map;
  return map;
}

/** All settings as a { key: string } map (cached; call load() after writes). */
const all = () => cache || {};
const get = (key) => (cache && cache[key] !== undefined ? cache[key] : '');
const bool = (key) => get(key) === '1';
const num = (key) => Number(get(key)) || 0;
const list = (key) => get(key).split(',').map((s) => s.trim()).filter(Boolean);

async function save(values) {
  for (const d of DEFS) {
    if (values[d.key] === undefined) continue;
    await db.query(
      'INSERT INTO settings(key, value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [d.key, String(values[d.key])]
    );
  }
  await load();
}

module.exports = { DEFS, load, all, get, bool, num, list, save };
