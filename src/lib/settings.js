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

  { group: 'Registration fee', key: 'fee_enabled', label: 'Charge a registration fee before bidding', type: 'bool', def: '1' },
  { group: 'Registration fee', key: 'fee_amount', label: 'Fee amount (₹, before GST)', type: 'number', def: '5000' },
  { group: 'Registration fee', key: 'fee_gst_percent', label: 'GST on fee (%)', type: 'number', def: '18' },
  { group: 'Registration fee', key: 'fee_validity_days', label: 'Fee validity (days)', type: 'number', def: '365', help: '0 means the fee is paid once and never expires.' },

  { group: 'Bidding rules', key: 'default_extend_window_min', label: 'Default auto-extend window (minutes)', type: 'number', def: '3', help: 'A bid in the last N minutes extends the lot. Each auction can override this.' },
  { group: 'Bidding rules', key: 'default_extend_by_min', label: 'Default extension length (minutes)', type: 'number', def: '3' },
  { group: 'Bidding rules', key: 'default_increment', label: 'Default bid increment (₹)', type: 'number', def: '100' },
  { group: 'Bidding rules', key: 'max_bid_jump_percent', label: 'Largest single jump above the minimum bid (%)', type: 'number', def: '50', help: 'Blocks typing mistakes such as an extra zero. 0 turns the check off.' },
  { group: 'Bidding rules', key: 'catalogue_public', label: 'Show lots and prices to visitors who are not signed in', type: 'bool', def: '1' },

  { group: 'Email', key: 'mail_from_name', label: 'Sender name', type: 'text', def: 'Kasturi Auction' },
  { group: 'Email', key: 'mail_from_email', label: 'Sender email', type: 'email', def: 'no-reply@example.com', help: 'Must be an address your mail provider lets you send from.' },
  { group: 'Email', key: 'admin_notify_email', label: 'Send admin alerts to', type: 'email', def: '', help: 'New document submissions, payments and enquiries.' },
  { group: 'Email', key: 'reminder_minutes_before', label: 'Auction reminder lead time (minutes)', type: 'number', def: '60', help: '0 turns reminders off.' },
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
