/**
 * Boot-time seeding. Runs on every start after the schema, so everything here is idempotent:
 * defaults are inserted only when missing and never overwrite what an admin has edited.
 *
 *   - default email templates and CMS pages
 *   - the first super admin (from ADMIN_EMAIL / ADMIN_PASSWORD)
 *   - optional demo data when SEED_DEMO=true and there are no auctions yet, and a one-time upgrade of
 *     older demo rows to formatted text and specifications
 */
const bcrypt = require('bcryptjs');
const db = require('./db');
const { DEFAULT_TEMPLATES } = require('./lib/mailer');

const PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------------------------
// CMS pages

const PAGES = [
  {
    slug: 'about',
    title: 'About us',
    body: `<h2>Who we are</h2>
<p>Kasturi Auction runs online forward auctions for industrial scrap and surplus material. We work with manufacturing plants, workshops, utilities and project sites that need to sell ferrous and non-ferrous scrap, used machinery and surplus stores in a transparent way, and with the traders, recyclers and end users who buy it.</p>
<h2>What we do for sellers</h2>
<ul>
<li>Prepare the lot list with quantities, units, start prices, increments and reserve prices.</li>
<li>Publish the auction with inspection arrangements and the seller's commercial terms.</li>
<li>Bring registered, document-checked buyers to every auction.</li>
<li>Run the live bidding and share the closing results for approval.</li>
</ul>
<h2>What we do for buyers</h2>
<ul>
<li>One registration and document check gives access to every auction on the platform.</li>
<li>Full lot details, inspection timings and terms before bidding starts.</li>
<li>Live bidding with a clear minimum bid, automatic extension for late bids, and email updates if you are outbid.</li>
<li>Your identity is never shown to other bidders.</li>
</ul>
<h2>Selling through us</h2>
<p>If you have scrap or surplus material to dispose of, contact us with the material type, approximate quantity and location. We will explain the process and the timeline for your first auction.</p>`,
  },
  {
    slug: 'how-it-works',
    title: 'How it works',
    body: `<h2>1. Register</h2>
<p>Create an account with your name, company, mobile number and email address. One account is meant for one business. Do not share your login with anyone outside your company.</p>
<h2>2. Verify your email</h2>
<p>We send a verification link to the email address you registered with. Open it to confirm the address. All auction notices, outbid alerts and award letters go to this address.</p>
<h2>3. Submit your business documents</h2>
<p>From your account page, fill in your business details and upload:</p>
<ul>
<li>GST registration certificate</li>
<li>PAN card of the business or proprietor</li>
<li>Address proof of the business premises</li>
</ul>
<p>Our team checks the documents against the details you entered. You will get an email when they are approved, or an email with the reason if something needs to be corrected.</p>
<h2>4. Pay the registration fee</h2>
<p>Pay the registration fee online from your account page using UPI, net banking or card. GST is charged on the fee. The fee is valid for the period shown on the payment page, and a receipt is emailed to you. If you prefer to pay by bank transfer, contact us before paying.</p>
<h2>5. Inspect the material</h2>
<p>Each auction page lists the lots, quantities, start prices and the inspection arrangements at the seller's site. Material is sold on an as-is, where-is basis, so inspect it before you bid. Quantities are estimates unless the auction says otherwise, and the final billing follows actual weighment.</p>
<h2>6. Bid live</h2>
<ol>
<li>Bidding opens at the start time shown on the auction page. Prices are per unit (per MT, KG, number or lot) unless the lot says otherwise.</li>
<li>Your bid must be at least the minimum bid shown, which is the current highest bid plus the lot's increment, or the start price for the first bid.</li>
<li>If a bid is placed in the closing minutes of a lot, the closing time of that lot is extended so that other bidders can respond. The extension window is shown on the auction page.</li>
<li>If two bids are for the same amount, the earlier bid ranks higher.</li>
<li>We email you if another bidder outbids you, but keep the auction page open during the closing minutes.</li>
<li>Other bidders never see your name or company.</li>
</ol>
<h2>7. Seller approval</h2>
<p>When a lot closes, the highest bid goes to the seller for approval. The seller may accept or reject it, for example when it is below their reserve price. A bid is binding on the bidder until the seller has decided.</p>
<h2>8. Award</h2>
<p>If your bid is accepted, we send you an award email with the lot, quantity and winning price. You can also see the result under My bids in your account.</p>
<h2>9. Payment and lifting</h2>
<p>Payment for the material, applicable taxes and lifting are handled directly between you and the seller, as set out in the terms of that auction. Typical terms cover the payment deadline, GST and TCS, weighment, loading, the lifting period and the documents you must bring, such as your GST certificate and vehicle papers. Read them before you bid.</p>`,
  },
  {
    slug: 'terms',
    title: 'Terms of use',
    body: `<!-- Draft starting text. Have these terms reviewed by your legal adviser and adjusted to your business before going live, then delete this note. -->
<h2>About these terms</h2>
<p>These terms apply to everyone who registers on or uses this website to view or bid in auctions. By registering, you accept them on behalf of yourself and the business you represent. Each auction may also have its own terms set by the seller. If the two conflict, the auction terms apply to that auction.</p>
<h2>Registration and eligibility</h2>
<ul>
<li>You must be at least 18 years old and authorised to act for the business you register.</li>
<li>The details and documents you submit must be true, current and your own. Tell us promptly if they change.</li>
<li>We may approve, reject or suspend a registration at our discretion, including where documents cannot be verified.</li>
<li>You are responsible for everything done using your login. Keep your password private.</li>
</ul>
<h2>Registration fee</h2>
<p>A registration fee may be charged before you can bid. The amount, applicable GST and validity period are shown before you pay. The fee covers access to the platform and is not adjusted against the price of any lot. It is not refundable once paid, except where we decide otherwise or the law requires it.</p>
<h2>Bids</h2>
<ul>
<li>Every bid is a binding offer to buy the lot at the bid price on the auction terms.</li>
<li>Prices are per unit stated for the lot and exclude taxes unless the auction says otherwise.</li>
<li>A bid placed in the closing minutes of a lot extends the closing time of that lot.</li>
<li>We may cancel a bid that is clearly a typing error, or any bid placed in breach of these terms. We may also extend, pause or cancel an auction or a lot if there is a technical problem or the seller withdraws the material.</li>
<li>The server time recorded by the platform is final for the timing and order of bids.</li>
</ul>
<h2>Award</h2>
<p>The highest bid on a lot is subject to the seller's approval. A lot is sold to you only when you receive an award from us. The seller may reject any bid, including the highest bid.</p>
<h2>Payment, taxes and lifting</h2>
<p>Payment for awarded lots, taxes such as GST and TCS, weighment, loading and lifting are arranged between the buyer and the seller according to the auction terms. You are responsible for meeting the payment and lifting deadlines, for any statutory licences or authorisations needed to buy, transport or process the material, and for following the seller's site safety rules.</p>
<h2>Condition of material</h2>
<p>Material is sold as is, where is. Descriptions, photographs and quantities are given in good faith but are estimates. You are expected to inspect the material before bidding. We do not give any warranty about quality, quantity or fitness for any purpose.</p>
<h2>Fair conduct</h2>
<p>You must not collude with other bidders, bid on your own or a related party's material to raise the price, use more than one account for the same business, or interfere with the working of the website. We may suspend accounts and cancel bids or awards where we find such conduct.</p>
<h2>Our responsibility</h2>
<p>We provide the auction platform and do not own the material sold. We are not a party to the sale contract between buyer and seller. We are not liable for losses arising from internet or device failures on your side, or from the acts of buyers or sellers. Nothing in these terms limits liability that cannot be limited by law.</p>
<h2>Changes</h2>
<p>We may update these terms from time to time. The version published on this page applies from the date it is published.</p>
<h2>Governing law</h2>
<p>These terms are governed by the laws of India.</p>
<h2>Contact</h2>
<p>For questions about these terms, use the contact page or write to the email address shown at the foot of this website.</p>`,
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    body: `<!-- Draft starting text. Have this policy reviewed by your legal adviser, name your grievance officer, and adjust it to your actual practices before going live, then delete this note. -->
<h2>What this policy covers</h2>
<p>This policy explains what personal data we collect when you use this website, why we collect it, and how you can control it.</p>
<h2>What we collect</h2>
<ul>
<li>Account details: name, email address, mobile number and password (stored in encrypted form).</li>
<li>Business details: company name, business type, GSTIN, PAN, address, and the documents you upload for verification.</li>
<li>Bidding activity: bids, the time they were placed and the IP address they came from.</li>
<li>Payments: amount, date and the reference given by the payment gateway. We do not receive or store your card or bank login details.</li>
<li>Messages you send us through the contact form or by email.</li>
</ul>
<h2>Why we use it</h2>
<ul>
<li>To verify that bidders are genuine businesses before they can bid.</li>
<li>To run auctions, record bids, and inform sellers and winning bidders of results.</li>
<li>To send you account emails, auction notices, outbid alerts and award letters.</li>
<li>To keep records required for tax, accounting and legal purposes, and to prevent fraud.</li>
</ul>
<h2>Who we share it with</h2>
<ul>
<li>Sellers: when a lot is awarded to you, we share your name, company and contact details with the seller of that lot so that payment and lifting can be arranged.</li>
<li>Service providers who help us run the website, such as hosting, email delivery and the payment gateway, only as needed for their service.</li>
<li>Authorities, where the law requires it.</li>
</ul>
<p>Other bidders never see your name, company or contact details. We do not sell your personal data.</p>
<h2>How long we keep it</h2>
<p>We keep your account data while your account is active. Bid, payment and document records are kept for as long as needed for legal, tax and dispute purposes, after which they are deleted.</p>
<h2>Security</h2>
<p>Passwords are stored as one-way hashes, the website uses encrypted connections, and access to bidder documents is limited to our staff who verify them.</p>
<h2>Cookies</h2>
<p>We use one essential cookie to keep you signed in. We do not use advertising cookies.</p>
<h2>Your choices</h2>
<ul>
<li>You can update your details from your account page.</li>
<li>You can stop auction announcement emails from your account page. Account and award emails are still sent.</li>
<li>You can ask us for a copy of your data, to correct it, or to close your account and delete it, subject to the records we must keep by law.</li>
</ul>
<p>We intend to handle personal data in line with applicable Indian law, including the Digital Personal Data Protection Act, 2023.</p>
<h2>Contact</h2>
<p>For privacy questions or complaints, write to the email address shown at the foot of this website.</p>`,
  },
];

// ---------------------------------------------------------------------------------------------

async function seedTemplates() {
  for (const t of DEFAULT_TEMPLATES) {
    await db.query(
      `INSERT INTO email_templates(key, name, description, variables, subject, body)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
      [t.key, t.name, t.description, t.variables, t.subject, t.body]
    );
  }
}

async function seedPages() {
  for (const p of PAGES) {
    await db.query('INSERT INTO pages(slug, title, body) VALUES($1,$2,$3) ON CONFLICT (slug) DO NOTHING', [p.slug, p.title, p.body]);
  }
}

async function seedAdmin() {
  const existing = await db.one('SELECT count(*)::int AS n FROM admins');
  if (existing.n > 0) return;

  let email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    if (PROD) {
      console.warn('[seed] WARNING: no admin account exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set. '
        + 'Set both environment variables and restart to create the first super admin.');
      return;
    }
    email = 'admin@kasturi.local';
    password = 'admin12345';
    console.log(`[seed] Created development super admin: ${email} / ${password}`);
  } else if (password.length < 8) {
    console.warn('[seed] WARNING: ADMIN_PASSWORD must be at least 8 characters. No admin account was created.');
    return;
  }
  const hash = await bcrypt.hash(password, 11);
  // ON CONFLICT covers two instances booting at the same moment.
  await db.query(
    `INSERT INTO admins(name, email, password_hash, role) VALUES('Administrator', $1, $2, 'superadmin') ON CONFLICT (email) DO NOTHING`,
    [email, hash]
  );
  if (process.env.ADMIN_EMAIL) console.log(`[seed] Created super admin ${email}`);
}

// ---------------------------------------------------------------------------------------------
// Demo data (SEED_DEMO=true). Invented companies and people, for reviewing the UI only.

const MIN = 60000;
const DAY = 24 * 60 * MIN;

const SELLERS = [
  { name: 'Shivalik Forgings Pvt Ltd', location: 'Focal Point, Ludhiana, Punjab', contact_name: 'Manoj Arora', contact_email: 'stores@shivalik-forgings.example', contact_phone: '+91 98140 11223',
    description: 'Closed-die forging and machining unit supplying automotive and tractor components. Sells forging and machining scrap every month.' },
  { name: 'Godavari Wire & Cable Industries Ltd', location: 'MIDC Satpur, Nashik, Maharashtra', contact_name: 'Sunil Deshmukh', contact_email: 'scrap@godavari-cables.example', contact_phone: '+91 98220 44871',
    description: 'Manufacturer of power and control cables. Sells copper and aluminium production scrap, drums and packing material.' },
  { name: 'Aravali Auto Components Pvt Ltd', location: 'Chakan MIDC, Pune, Maharashtra', contact_name: 'Rohit Kulkarni', contact_email: 'purchase@aravali-auto.example', contact_phone: '+91 97300 65512',
    description: 'Aluminium die-casting and machining plant. Periodically disposes of process scrap and replaced machinery.' },
  { name: 'Sabarmati Power & Utilities Ltd', location: 'Naroda GIDC, Ahmedabad, Gujarat', contact_name: 'Kalpesh Shah', contact_email: 'disposal@sabarmati-power.example', contact_phone: '+91 99250 30418',
    description: 'Captive power and utilities operator. Sells used batteries, transformers and dismantled structures.' },
];

const STEEL_TERMS = `Prices are per MT, exclusive of GST and TCS, which will be charged as applicable.

The successful bidder must pay 25% of the estimated value within 3 working days of the award and the balance before lifting each consignment. Payment is by RTGS or NEFT to the seller's account only.

Lifting must be completed within 15 days of the award, between 9 am and 5 pm on working days. Weighment is on the seller's weighbridge and is final.

The buyer arranges loading labour, vehicles and gas cutting where needed, and follows the plant safety rules. Vehicles must carry valid papers and drivers must wear safety shoes and helmets.`;

const NONFERROUS_TERMS = `Prices are per unit stated for each lot, exclusive of GST and TCS.

Full payment is due within 5 working days of the award, by RTGS or NEFT to the seller. Material is released only after the payment is credited.

Lifting within 10 days of payment. Weighment on the seller's weighbridge in the presence of the buyer's representative. Wooden drums and HDPE drums are counted at the time of loading.

Copper and aluminium scrap is sold on actual weight including insulation, as is where is.`;

const MACHINE_TERMS = `Prices are per number or per lot as stated, exclusive of GST and TCS.

Full payment is due within 7 working days of the award. Machines are sold as is, where is, with no warranty of working condition.

The buyer dismantles, loads and removes the machines at their own cost and risk within 21 days of payment, with a competent rigging crew and their own crane where needed. Foundations and cabling stay with the seller unless the lot says otherwise.`;

const BATTERY_TERMS = `Prices are per KG or per number as stated, exclusive of GST and TCS.

Used lead-acid batteries will only be sold to bidders holding valid registration as a recycler or dealer under the Battery Waste Management Rules, 2022. A copy must be submitted before lifting.

Full payment within 5 working days of the award. Lifting within 15 days, with spill-proof vehicles for batteries. Transformers are drained of oil before sale.`;

// d: offsets from now (ms). lots: [title, description, qty, unit, start, increment, reserve|null]
const AUCTIONS = [
  {
    key: 'live1', seller: 0, phase: 'live', start: -20 * MIN, end: 25 * MIN,
    title: 'Forging and machining steel scrap, Ludhiana', category: 'Ferrous scrap', location: 'Focal Point, Ludhiana, Punjab',
    description: 'Monthly sale of process scrap from a forging and machining plant. All material is stored under a shed in separate heaps and is free from oil sludge unless stated.',
    inspection: 'Inspection at the seller\'s plant on working days, 10 am to 4 pm, until the day before the auction. Contact Manoj Arora on +91 98140 11223 to book a slot. Carry your company ID.',
    terms: STEEL_TERMS,
    lots: [
      ['HR coil end cuttings', 'Hot-rolled coil heads and tails, 2 to 8 mm thick, widths up to 1250 mm. Clean, no coating.', 120, 'MT', 38500, 200, 39500],
      ['CRCA sheet cuttings in bundles', 'Cold-rolled sheet offcuts from blanking, 0.8 to 2 mm, baled in bundles of about 1 MT.', 45, 'MT', 40200, 200, null],
      ['MS turning and boring', 'Mild steel turnings and borings from CNC machining. Light coolant traces, stored in bins.', 80, 'MT', 29800, 100, null],
      ['Forging flash and end pieces', 'Trimming flash, end bits and rejected forgings in alloy steel (EN8, EN19, 20MnCr5).', 35, 'MT', 36500, 200, 37000],
      ['Used die blocks', 'Worn-out hot-work die blocks, H11 and DB6 grades, single pieces up to 1.2 MT.', 18, 'MT', 41000, 250, null],
    ],
  },
  {
    key: 'live2', seller: 1, phase: 'live', start: -20 * MIN, end: 50 * MIN,
    title: 'Copper and aluminium cable scrap, drums and packing, Nashik', category: 'Non-ferrous scrap', location: 'MIDC Satpur, Nashik, Maharashtra',
    description: 'Production scrap from a cable plant. Copper and aluminium lots are stored in bags on pallets inside the factory scrap yard.',
    inspection: 'Inspection Monday to Saturday, 10 am to 5 pm. Contact Sunil Deshmukh on +91 98220 44871. Sample stripping allowed with permission.',
    terms: NONFERROUS_TERMS,
    lots: [
      ['PVC insulated copper cable scrap', 'Multi-core copper cable offcuts, 1.5 to 16 sq mm, PVC insulated. Copper recovery about 60 to 65%.', 6500, 'KG', 545, 2, 560],
      ['Armoured copper cable drum ends', 'Armoured copper power cable ends, 25 to 240 sq mm, steel wire armour, PVC sheathed.', 3200, 'KG', 480, 2, null],
      ['Aluminium wire rod offcuts', 'EC grade aluminium rod, 9.5 mm, coil ends and rejects. Bare and clean.', 9000, 'KG', 192, 1, null],
      ['Used wooden cable drums', 'Wooden cable drums, 1000 to 1800 mm flange diameter. Mixed condition.', 140, 'Nos', 1200, 50, null],
      ['HDPE drums, 200 litre', 'Empty blue HDPE drums, previously used for compound and lubricant. Rinsed, with lids.', 600, 'Nos', 340, 10, null],
    ],
  },
  {
    key: 'up1', seller: 2, phase: 'upcoming', start: 1 * DAY, end: 1 * DAY + 3 * 60 * MIN,
    title: 'Plant machinery and utility surplus, Chakan', category: 'Machinery and equipment', location: 'Chakan MIDC, Pune, Maharashtra',
    description: 'Replaced machines and utilities from a plant modernisation. Machines are disconnected and can be seen at their present locations in the plant.',
    inspection: 'Inspection on the two working days before the auction, 10 am to 4 pm. Contact Rohit Kulkarni on +91 97300 65512. Running demonstrations are not possible.',
    terms: MACHINE_TERMS,
    lots: [
      ['250 kVA diesel generator set', 'Silent canopy, 2014 make, about 18,000 running hours. Last serviced in 2025. With control panel.', 1, 'Nos', 620000, 5000, 700000],
      ['CNC turning lathe, 2-axis', '2011 make, 400 mm swing, 8-station turret, Fanuc control. Spindle bearings recently replaced.', 1, 'Nos', 450000, 5000, null],
      ['Screw air compressor, 50 HP', 'Oil-injected, 2012 make, with air receiver and dryer. Working when removed.', 1, 'Nos', 180000, 2000, null],
      ['EOT crane, 5 tonne', 'Single girder, 12 m span, with end carriages and pendant. Gantry rails not included.', 1, 'Nos', 260000, 2500, 280000],
      ['Used electric motors, mixed', 'About 40 induction motors, 2 to 30 kW, some with gearboxes. Sold as one lot.', 1, 'Lot', 85000, 1000, null],
    ],
  },
  {
    key: 'up2', seller: 2, phase: 'upcoming', start: 3 * DAY, end: 3 * DAY + 2 * 60 * MIN,
    title: 'Aluminium die-casting and extrusion scrap, Chakan', category: 'Non-ferrous scrap', location: 'Chakan MIDC, Pune, Maharashtra',
    description: 'Process scrap from aluminium die-casting and machining. Each grade is stored separately in jumbo bags.',
    inspection: 'Inspection on working days, 11 am to 4 pm. Contact Rohit Kulkarni on +91 97300 65512.',
    terms: NONFERROUS_TERMS,
    lots: [
      ['Aluminium extrusion scrap, 6063', 'Profile offcuts and rejects, mill finish and anodised. No thermal break or plastic.', 12000, 'KG', 188, 1, null],
      ['Aluminium die-cast scrap, ADC12', 'Runners, overflows and rejected castings. Some iron inserts in rejected parts.', 8500, 'KG', 158, 1, 162],
      ['Aluminium turnings', 'Dry aluminium turnings and chips, centrifuged. Moisture under 2%.', 4000, 'KG', 132, 1, null],
      ['Cast iron borings', 'Grey cast iron borings from brake drum machining. Stored under shed.', 60, 'MT', 27500, 100, null],
    ],
  },
  {
    key: 'up3', seller: 3, phase: 'upcoming', start: 5 * DAY, end: 5 * DAY + 2 * 60 * MIN,
    title: 'Used batteries, transformers and structural scrap, Ahmedabad', category: 'Mixed scrap', location: 'Naroda GIDC, Ahmedabad, Gujarat',
    description: 'Material from the replacement of a UPS battery bank and two substations, and from dismantling of an old cooling tower structure.',
    inspection: 'Inspection on working days, 10 am to 4 pm. Contact Kalpesh Shah on +91 99250 30418. Batteries are stacked on pallets in the stores yard.',
    terms: BATTERY_TERMS,
    lots: [
      ['Used lead-acid batteries', 'Sealed maintenance-free and flooded cells, 2 V and 12 V, from UPS banks. Drained of acid where flooded.', 18000, 'KG', 98, 1, 100],
      ['Distribution transformers, 500 kVA', 'Copper wound, 11 kV / 433 V, 2004 make. Oil drained. Weight about 2.4 MT each.', 3, 'Nos', 150000, 2000, null],
      ['Stainless steel 304 scrap', 'Pipes, sheets and fittings from water treatment lines. Magnet tested.', 5000, 'KG', 128, 1, null],
      ['MS structural scrap', 'Dismantled beams, channels and angles from cooling tower structure, cut to 1.5 m lengths.', 70, 'MT', 34500, 100, null],
    ],
  },
  {
    key: 'closed1', seller: 0, phase: 'closed', start: -6 * DAY, end: -6 * DAY + 2 * 60 * MIN,
    title: 'Forging and machining steel scrap, Ludhiana, previous sale', category: 'Ferrous scrap', location: 'Focal Point, Ludhiana, Punjab',
    description: 'Previous monthly sale of process scrap from the forging and machining plant.',
    inspection: 'Inspection was available on working days before the auction.',
    terms: STEEL_TERMS,
    // results: one per lot
    results: ['awarded', 'awarded', 'pending'],
    lots: [
      ['MS turning and boring', 'Mild steel turnings and borings from CNC machining.', 60, 'MT', 29500, 100, null],
      ['HMS 1 and 2', 'Heavy melting scrap from plant maintenance, cut to furnace size.', 90, 'MT', 35000, 200, null],
      ['Forging end cuttings', 'Alloy steel end cuttings and rejected forgings.', 40, 'MT', 36000, 200, 38500],
    ],
  },
  {
    key: 'closed2', seller: 1, phase: 'closed', start: -3 * DAY, end: -3 * DAY + 90 * MIN,
    title: 'Cable scrap and wooden drums, Nashik, previous sale', category: 'Non-ferrous scrap', location: 'MIDC Satpur, Nashik, Maharashtra',
    description: 'Previous sale of cable production scrap and packing material.',
    inspection: 'Inspection was available on working days before the auction.',
    terms: NONFERROUS_TERMS,
    results: ['awarded', 'awarded', 'no_bids'],
    lots: [
      ['PVC insulated copper cable scrap', 'Multi-core copper cable offcuts, PVC insulated.', 4800, 'KG', 540, 2, null],
      ['Aluminium cable scrap, XLPE', 'Aluminium conductor XLPE cable offcuts, 35 to 300 sq mm.', 7000, 'KG', 118, 1, null],
      ['Damaged wooden drums', 'Broken wooden drums for firewood or repair.', 90, 'Nos', 450, 25, null],
    ],
  },
];

// [name, company, business_type, city, state, state_code, pincode, pan, phone, address]
const BIDDERS = [
  ['Rajesh Goyal', 'Goyal Steel Traders', 'Trader', 'Ludhiana', 'Punjab', '03', '141010', 'AFKPG4821K', '+91 98155 20114', 'Plot 18, Industrial Area B, Ludhiana'],
  ['Imran Shaikh', 'Al-Noor Metal Recycling', 'Recycler', 'Bhiwandi', 'Maharashtra', '27', '421302', 'ABQFA7302M', '+91 98201 66350', 'Gala 7, Kalher Industrial Estate, Bhiwandi'],
  ['Suresh Patel', 'Shree Umiya Alloys', 'Manufacturer', 'Ahmedabad', 'Gujarat', '24', '382445', 'AAJCS5519D', '+91 99099 41207', 'Shed 112, Phase 2, Vatva GIDC, Ahmedabad'],
  ['K. Senthil Kumar', 'Sri Murugan Scrap Traders', 'Trader', 'Chennai', 'Tamil Nadu', '33', '600118', 'BGNPK2286Q', '+91 94440 18733', '23, Manali High Road, Chennai'],
  ['Amit Agarwal', 'Mahavir Non-Ferrous Industries', 'Recycler', 'New Delhi', 'Delhi', '07', '110041', 'AAGFM6043R', '+91 98110 52298', 'Plot 44, Mundka Industrial Area, New Delhi'],
  ['P. Venkata Reddy', 'Sai Balaji Metals', 'Trader', 'Hyderabad', 'Telangana', '36', '500055', 'CEHPR9157L', '+91 98490 73316', '5-12, IDA Jeedimetla, Hyderabad'],
];
const PENDING_BIDDER = ['Harpreet Singh', 'Guru Kirpa Enterprises', 'Trader', 'Mandi Gobindgarh', 'Punjab', '03', '147301', 'DLMPS3870H', '+91 98728 40916', 'GT Road, Mandi Gobindgarh'];

// ---------------------------------------------------------------------------------------------
// v2 demo content: editor-style HTML for descriptions, inspection and terms, plus lot specifications.
// Used for a fresh demo seed, and once to upgrade demo rows created before v2 (see upgradeDemo).

/** specs('Grade: EN8', 'Form: Bundles') -> [{ label, value }] */
const specs = (...pairs) => pairs.map((p) => { const i = p.indexOf(': '); return { label: p.slice(0, i), value: p.slice(i + 2) }; });

const TERMS_HTML = {
  steel: `<h2>Price and taxes</h2>
<p>Prices are per MT, exclusive of GST and TCS, which will be charged as applicable.</p>
<h2>Payment</h2>
<ul>
<li>25% of the estimated value within 3 working days of the award.</li>
<li>Balance before lifting each consignment.</li>
<li>By RTGS or NEFT to the seller's account only. Cash and cheques are not accepted.</li>
</ul>
<h2>Lifting and weighment</h2>
<ul>
<li>Lifting within 15 days of the award, 9 am to 5 pm on working days.</li>
<li>Weighment on the seller's weighbridge is final.</li>
<li>The buyer arranges loading labour, vehicles and gas cutting where needed.</li>
</ul>
<h3>Site safety</h3>
<p>Vehicles must carry valid papers. Drivers and labour must wear safety shoes and helmets and follow the plant safety rules at all times.</p>`,
  nonferrous: `<h2>Price and taxes</h2>
<p>Prices are per unit stated for each lot, exclusive of GST and TCS.</p>
<h2>Payment</h2>
<p>Full payment within 5 working days of the award, by RTGS or NEFT to the seller. Material is released only after the payment is credited.</p>
<h2>Lifting and weighment</h2>
<ul>
<li>Lifting within 10 days of payment.</li>
<li>Weighment on the seller's weighbridge in the presence of the buyer's representative.</li>
<li>Wooden and HDPE drums are counted at the time of loading.</li>
</ul>
<p>Copper and aluminium scrap is sold on actual weight including insulation, as is where is.</p>`,
  machine: `<h2>Price and taxes</h2>
<p>Prices are per number or per lot as stated, exclusive of GST and TCS.</p>
<h2>Payment</h2>
<p>Full payment within 7 working days of the award.</p>
<h2>Condition</h2>
<p>Machines are sold <strong>as is, where is</strong>, with no warranty of working condition. Inspect before bidding.</p>
<h2>Dismantling and removal</h2>
<ul>
<li>The buyer dismantles, loads and removes the machines at their own cost and risk within 21 days of payment.</li>
<li>A competent rigging crew is required, with the buyer's own crane where needed.</li>
<li>Foundations and cabling stay with the seller unless the lot says otherwise.</li>
</ul>`,
  battery: `<h2>Price and taxes</h2>
<p>Prices are per KG or per number as stated, exclusive of GST and TCS.</p>
<h2>Eligibility for battery lots</h2>
<p>Used lead-acid batteries are sold only to bidders registered as a recycler or dealer under the <em>Battery Waste Management Rules, 2022</em>. Submit a copy of the registration before lifting.</p>
<h2>Payment and lifting</h2>
<ul>
<li>Full payment within 5 working days of the award.</li>
<li>Lifting within 15 days, with spill-proof vehicles for batteries.</li>
<li>Transformers are drained of oil before sale.</li>
</ul>`,
};

const inspectionHtml = (when, contact, extra) => `<ul>
<li><strong>When:</strong> ${when}</li>
<li><strong>Contact:</strong> ${contact}</li>
${extra.map((x) => `<li>${x}</li>`).join('\n')}
</ul>`;

// Keyed by the demo auction key; lots in the same order as AUCTIONS[].lots.
const RICH = {
  live1: {
    description: `<p>Monthly sale of process scrap from a closed-die forging and machining plant supplying automotive and tractor components.</p>
<h2>Storage and condition</h2>
<ul>
<li>All material is stored under a shed in separate heaps, one heap per lot.</li>
<li>Free from oil sludge unless the lot says otherwise.</li>
<li>Quantities are estimates; billing follows actual weighment.</li>
</ul>`,
    inspection: inspectionHtml('Working days, 10 am to 4 pm, until the day before the auction.', 'Manoj Arora, +91 98140 11223. Book a slot in advance.', ['Carry your company ID and wear safety shoes.']),
    lots: [
      [`<p>Hot-rolled coil heads and tails from the slitting line. Clean material with no coating or paint.</p>
<ul><li>Mixed widths up to 1250 mm</li><li>Stacked by thickness in two heaps</li></ul>`,
        specs('Grade: IS 2062 E250', 'Thickness: 2 to 8 mm', 'Form: Coil end cuttings', 'Condition: Clean, uncoated', 'Packing: Loose', 'Loading: By buyer, magnet crane available')],
      [`<p>Cold-rolled sheet offcuts from the blanking presses, baled in bundles of about 1 MT. Suitable for direct charging.</p>`,
        specs('Grade: CRCA IS 513', 'Thickness: 0.8 to 2 mm', 'Form: Baled bundles, about 1 MT each', 'Condition: Clean, light oil film', 'Packing: Bundles', 'Loading: Forklift by seller')],
      [`<p>Mild steel turnings and borings from CNC machining, collected in bins at each cell.</p>
<p>Light coolant traces are present; the material is drained before sale.</p>`,
        specs('Grade: Mild steel, EN8 and EN9', 'Form: Turnings and borings', 'Condition: Drained, light coolant traces', 'Packing: Bins, tipped at loading', 'Loading: By buyer with JCB')],
      [`<p>Trimming flash, end bits and rejected forgings in alloy steel. Grades are kept separate in marked heaps.</p>
<ul><li>EN8 and EN19 heap</li><li>20MnCr5 heap</li></ul>`,
        specs('Grade: EN8, EN19, 20MnCr5', 'Size: Up to 400 mm', 'Form: Flash, end pieces and rejects', 'Condition: Dry, some scale', 'Packing: Loose heaps', 'Loading: By buyer')],
      [`<p>Worn-out hot-work die blocks taken out of service. Single pieces, some with lifting holes.</p>`,
        specs('Grade: H11 and DB6', 'Size: Single pieces up to 1.2 MT', 'Condition: Worn, cracked faces', 'Packing: Loose on pallets', 'Loading: 5 tonne EOT crane by seller')],
    ],
  },
  live2: {
    description: `<p>Production scrap from a power and control cable plant. Copper and aluminium lots are bagged on pallets inside the factory scrap yard; drums are stacked in the open yard.</p>
<h2>Good to know</h2>
<ul>
<li>Sample stripping is allowed during inspection with permission.</li>
<li>Recovery figures are the seller's estimates from past sales.</li>
</ul>`,
    inspection: inspectionHtml('Monday to Saturday, 10 am to 5 pm.', 'Sunil Deshmukh, +91 98220 44871.', ['Sample stripping allowed with permission.']),
    lots: [
      [`<p>Multi-core copper cable offcuts from the laying-up and sheathing lines, PVC insulated.</p>`,
        specs('Size: 1.5 to 16 sq mm, multi-core', 'Form: Cable offcuts', 'Condition: PVC insulated', 'Recovery: Copper about 60 to 65%', 'Packing: Jumbo bags on pallets', 'Loading: Forklift by seller')],
      [`<p>Armoured copper power cable ends left on drums after cutting to customer lengths.</p>
<ul><li>Steel wire armour, PVC sheathed</li><li>Lengths of 1 to 6 m</li></ul>`,
        specs('Size: 25 to 240 sq mm', 'Form: Drum ends', 'Condition: Armoured, PVC sheathed', 'Packing: Loose on pallets', 'Loading: Forklift by seller')],
      [`<p>EC grade aluminium rod, coil ends and rejects from the drawing section. Bare and clean.</p>`,
        specs('Grade: EC grade aluminium', 'Size: 9.5 mm rod', 'Form: Coil ends and rejects', 'Condition: Bare, clean', 'Packing: Coils', 'Loading: Forklift by seller')],
      [`<p>Wooden cable drums returned from sites. Mixed condition: some reusable, some for repair or firewood.</p>`,
        specs('Size: 1000 to 1800 mm flange', 'Condition: Mixed', 'Packing: Stacked in open yard', 'Loading: By buyer')],
      [`<p>Empty blue HDPE drums previously used for compound and lubricant. Rinsed, with lids.</p>`,
        specs('Size: 200 litre', 'Condition: Rinsed, with lids', 'Packing: Stacked on pallets', 'Loading: By buyer')],
    ],
  },
  up1: {
    description: `<p>Replaced machines and utilities from a plant modernisation at an aluminium die-casting unit.</p>
<h2>Before you bid</h2>
<ul>
<li>Machines are disconnected and can be seen at their present locations in the plant.</li>
<li>Running demonstrations are not possible.</li>
<li>Manuals and service records are available for the generator and the compressor.</li>
</ul>`,
    inspection: inspectionHtml('The two working days before the auction, 10 am to 4 pm.', 'Rohit Kulkarni, +91 97300 65512.', ['Running demonstrations are not possible.']),
    lots: [
      [`<p>Silent-canopy diesel generator set with its control panel. Serviced regularly until it was replaced by a grid connection.</p>
<ul><li>About 18,000 running hours</li><li>Last serviced in 2025</li></ul>`,
        specs('Make: Kirloskar', 'Capacity: 250 kVA', 'Year: 2014', 'Running hours: About 18,000', 'Condition: Working when removed', 'Loading: By buyer, crane required')],
      [`<p>2-axis CNC turning lathe with an 8-station turret. Spindle bearings were replaced 18 months ago.</p>`,
        specs('Make: Ace Micromatic', 'Model: Jobber XL', 'Year: 2011', 'Size: 400 mm swing', 'Condition: Working when removed, Fanuc control', 'Loading: By buyer')],
      [`<p>Oil-injected screw air compressor with air receiver and refrigerated dryer.</p>`,
        specs('Make: Elgi', 'Capacity: 50 HP', 'Year: 2012', 'Condition: Working when removed', 'Loading: By buyer')],
      [`<p>Single girder EOT crane with end carriages and pendant control. Gantry rails are not included.</p>`,
        specs('Capacity: 5 tonne', 'Size: 12 m span', 'Condition: Dismantled, ready for lifting', 'Loading: By buyer, crane required')],
      [`<p>About 40 induction motors from 2 to 30 kW, some with gearboxes. Sold as one lot.</p>`,
        specs('Size: 2 to 30 kW', 'Condition: Mixed, untested', 'Packing: On pallets', 'Loading: Forklift by seller')],
    ],
  },
  up2: {
    description: `<p>Process scrap from aluminium die-casting and machining. Each grade is stored separately in jumbo bags.</p>
<ul><li>Bags are weighed at loading.</li><li>Moisture figures are from the seller's last test.</li></ul>`,
    inspection: inspectionHtml('Working days, 11 am to 4 pm.', 'Rohit Kulkarni, +91 97300 65512.', ['Carry your company ID.']),
    lots: [
      [`<p>Profile offcuts and rejects from the extrusion press, mill finish and anodised. No thermal break or plastic.</p>`,
        specs('Grade: 6063', 'Form: Extrusion offcuts', 'Condition: Clean, no plastic', 'Packing: Jumbo bags', 'Loading: Forklift by seller')],
      [`<p>Runners, overflows and rejected castings. Some rejected parts carry iron inserts.</p>`,
        specs('Grade: ADC12', 'Form: Runners and rejected castings', 'Condition: Some iron inserts', 'Packing: Jumbo bags', 'Loading: Forklift by seller')],
      [`<p>Dry aluminium turnings and chips from machining, centrifuged before bagging.</p>`,
        specs('Form: Turnings and chips', 'Condition: Centrifuged, moisture under 2%', 'Packing: Jumbo bags', 'Loading: Forklift by seller')],
      [`<p>Grey cast iron borings from brake drum machining, stored under a shed.</p>`,
        specs('Grade: Grey cast iron', 'Form: Borings', 'Condition: Dry, under shed', 'Packing: Loose', 'Loading: By buyer with JCB')],
    ],
  },
  up3: {
    description: `<p>Material from the replacement of a UPS battery bank and two substations, and from the dismantling of an old cooling tower structure.</p>
<h2>Important</h2>
<ul>
<li>Battery lots are only for registered recyclers and dealers. See the terms.</li>
<li>Transformers are drained of oil before sale.</li>
</ul>`,
    inspection: inspectionHtml('Working days, 10 am to 4 pm.', 'Kalpesh Shah, +91 99250 30418.', ['Batteries are stacked on pallets in the stores yard.']),
    lots: [
      [`<p>Sealed maintenance-free and flooded cells from UPS banks. Flooded cells are drained of acid.</p>`,
        specs('Form: 2 V and 12 V cells', 'Condition: Drained where flooded', 'Packing: Shrink-wrapped on pallets', 'Loading: Forklift by seller, spill-proof vehicle required')],
      [`<p>Copper wound distribution transformers taken out of two substations. Oil drained.</p>`,
        specs('Capacity: 500 kVA, 11 kV / 433 V', 'Year: 2004', 'Condition: Oil drained', 'Size: About 2.4 MT each', 'Loading: By buyer, crane required')],
      [`<p>Pipes, sheets and fittings from water treatment lines. Magnet tested.</p>`,
        specs('Grade: SS 304', 'Form: Pipes, sheets and fittings', 'Condition: Magnet tested', 'Packing: Loose', 'Loading: By buyer')],
      [`<p>Beams, channels and angles from the dismantled cooling tower structure, already cut to length.</p>`,
        specs('Form: Beams, channels and angles', 'Size: Cut to 1.5 m lengths', 'Condition: Painted, some rust', 'Packing: Loose', 'Loading: By buyer with crane')],
    ],
  },
  closed1: {
    description: `<p>Previous monthly sale of process scrap from the forging and machining plant.</p>`,
    inspection: `<p>Inspection was available on working days before the auction.</p>`,
    lots: [
      [`<p>Mild steel turnings and borings from CNC machining.</p>`, specs('Grade: Mild steel', 'Form: Turnings and borings', 'Packing: Bins', 'Loading: By buyer')],
      [`<p>Heavy melting scrap from plant maintenance, cut to furnace size.</p>`, specs('Grade: HMS 1 and 2 (80:20)', 'Size: Cut to furnace size', 'Packing: Loose', 'Loading: By buyer')],
      [`<p>Alloy steel end cuttings and rejected forgings.</p>`, specs('Grade: EN8, EN19', 'Form: End cuttings and rejects', 'Packing: Loose', 'Loading: By buyer')],
    ],
  },
  closed2: {
    description: `<p>Previous sale of cable production scrap and packing material.</p>`,
    inspection: `<p>Inspection was available on working days before the auction.</p>`,
    lots: [
      [`<p>Multi-core copper cable offcuts, PVC insulated.</p>`, specs('Form: Cable offcuts', 'Condition: PVC insulated', 'Packing: Jumbo bags', 'Loading: Forklift by seller')],
      [`<p>Aluminium conductor XLPE cable offcuts.</p>`, specs('Size: 35 to 300 sq mm', 'Condition: XLPE insulated', 'Packing: Loose', 'Loading: By buyer')],
      [`<p>Broken wooden drums for firewood or repair.</p>`, specs('Condition: Broken', 'Packing: Stacked', 'Loading: By buyer')],
    ],
  },
};
const TERMS_KEY = { live1: 'steel', closed1: 'steel', live2: 'nonferrous', up2: 'nonferrous', closed2: 'nonferrous', up1: 'machine', up3: 'battery' };

/**
 * One-time upgrade of demo rows created before v2 (SEED_DEMO=true only). A demo auction is
 * recognised by its exact title and demo seller name; its text is replaced only while it is still
 * plain text, and a lot only while its specs are empty and its description is plain text, so
 * anything an admin has edited is left alone.
 */
async function upgradeDemo() {
  if (process.env.SEED_DEMO !== 'true') return;
  let n = 0;
  for (const a of AUCTIONS) {
    const r = RICH[a.key];
    const row = await db.one(
      `SELECT a.id FROM auctions a JOIN sellers s ON s.id = a.seller_id WHERE a.title = $1 AND s.name = $2 ORDER BY a.id LIMIT 1`,
      [a.title, SELLERS[a.seller].name]);
    if (!row) continue;
    await db.query(
      `UPDATE auctions SET description = CASE WHEN description NOT LIKE '<%' THEN $2 ELSE description END,
                           inspection  = CASE WHEN inspection  NOT LIKE '<%' THEN $3 ELSE inspection END,
                           terms       = CASE WHEN terms       NOT LIKE '<%' THEN $4 ELSE terms END
        WHERE id = $1 AND (description NOT LIKE '<%' OR inspection NOT LIKE '<%' OR terms NOT LIKE '<%')`,
      [row.id, r.description, r.inspection, TERMS_HTML[TERMS_KEY[a.key]]]);
    for (let i = 0; i < a.lots.length; i++) {
      const res = await db.query(
        `UPDATE lots SET description = $3, specs = $4::jsonb
          WHERE auction_id = $1 AND lot_no = $2 AND title = $5 AND specs = '[]'::jsonb AND description NOT LIKE '<%'`,
        [row.id, i + 1, r.lots[i][0], JSON.stringify(r.lots[i][1]), a.lots[i][0]]);
      n += res.rowCount;
    }
  }
  if (n) console.log(`[seed] Upgraded ${n} demo lot(s) with formatted descriptions and specifications`);
}

/** Small deterministic random generator so demo data looks the same on every fresh seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function seedDemo() {
  if (process.env.SEED_DEMO !== 'true') return;
  if ((await db.one('SELECT count(*)::int AS n FROM auctions')).n > 0) return;

  const hash = await bcrypt.hash('demo12345', 11);
  const now = Date.now();
  const at = (offset) => new Date(now + offset);
  const rand = rng(20261122);

  const created = await db.tx(async (c) => {
    // Serialise with any other instance seeding at the same moment, then re-check.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('kasturi-seed-demo'))`);
    if ((await c.query('SELECT 1 FROM auctions LIMIT 1')).rowCount) return false;

    const q = async (sql, params) => (await c.query(sql, params)).rows[0];

    // Bidders. Upsert on email so a rerun after auctions were deleted does not fail.
    // email_opt_out is on so that auction announcements and reminders are not queued to demo addresses.
    const addUser = (b, status, extra) => q(
      `INSERT INTO users(email, password_hash, name, phone, company_name, business_type, gstin, pan, address, city, state, pincode,
                         email_verified, kyc_status, kyc_submitted_at, fee_paid_until, email_opt_out, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [extra.email, hash, b[0], b[8], b[1], b[2], b[5] + b[7] + '1Z' + 'ABCDEFGHJK'[b[7].charCodeAt(9) % 10], b[7], b[9], b[3], b[4], b[6],
        extra.verified, status, extra.submitted, extra.feeUntil, extra.created]
    );

    const bidders = [];
    for (let i = 0; i < BIDDERS.length; i++) {
      const created = at(-(40 + i * 6) * DAY);
      const paidAt = at(-(30 - i * 4) * DAY);
      const u = await addUser(BIDDERS[i], 'approved', {
        email: `trader${i + 1}@demo.kasturi.local`, verified: true, submitted: at(-(38 + i * 6) * DAY),
        feeUntil: new Date(paidAt.getTime() + 365 * DAY), created,
      });
      bidders.push(u.id);

      // Registration fee: five paid online, one recorded as a bank transfer.
      const offline = i === 5;
      await c.query(
        `INSERT INTO payments(user_id, base_amount, tax_amount, amount, method, status, rp_order_id, rp_payment_id, note, created_at, paid_at)
         SELECT $1, 5000, 900, 5900, $2, 'paid', $3, $4, $5, $6, $6
          WHERE NOT EXISTS (SELECT 1 FROM payments WHERE user_id = $1)`,
        [u.id, offline ? 'offline' : 'razorpay', offline ? null : `order_DEMO${String(i + 1).padStart(8, '0')}`,
          offline ? null : `pay_DEMO${String(i + 1).padStart(10, '0')}`, offline ? 'NEFT received, UTR HDFCN52026112200417' : '', paidAt]
      );
    }
    await addUser(PENDING_BIDDER, 'pending', {
      email: 'trader7@demo.kasturi.local', verified: true, submitted: at(-1 * DAY), feeUntil: null, created: at(-2 * DAY),
    });
    await q(
      `INSERT INTO users(email, password_hash, name, phone, city, state, email_verified, kyc_status, email_opt_out, created_at)
       VALUES('trader8@demo.kasturi.local', $1, 'Prakash Jadhav', '+91 90110 27745', 'Pune', 'Maharashtra', false, 'incomplete', true, $2)
       ON CONFLICT (email) DO NOTHING RETURNING id`, [hash, at(-6 * 60 * MIN)]
    );

    const sellerIds = [];
    for (const s of SELLERS) {
      const r = await q(
        `INSERT INTO sellers(name, location, description, contact_name, contact_email, contact_phone)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [s.name, s.location, s.description, s.contact_name, s.contact_email, s.contact_phone]
      );
      sellerIds.push(r.id);
    }

    /**
     * Insert a run of valid ascending bids on one lot between two times. Each bid is the
     * previous one plus one to three increments, and no bidder outbids themselves.
     * Returns the id of the highest (last) bid.
     */
    async function addBids(lot, count, fromMs, toMs) {
      let amount = lot.start;
      let prev = -1;
      let lastId = null;
      for (let k = 0; k < count; k++) {
        if (k > 0) amount = Math.round((amount + lot.inc * (1 + Math.floor(rand() * 3))) * 100) / 100;
        let who;
        do { who = Math.floor(rand() * bidders.length); } while (who === prev);
        prev = who;
        const t = new Date(fromMs + ((toMs - fromMs) * (k + rand() * 0.5)) / count);
        const r = await q('INSERT INTO bids(lot_id, user_id, amount, ip, created_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [lot.id, bidders[who], amount, `203.0.113.${10 + who}`, t]);
        lastId = r.id;
      }
      return lastId;
    }

    for (const a of AUCTIONS) {
      const startsAt = at(a.start);
      const endsAt = at(a.end);
      const auction = await q(
        `INSERT INTO auctions(title, seller_id, category, location, description, inspection, terms, starts_at, ends_at, status,
                              extend_window_min, extend_by_min, reminder_sent, announced_at, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',3,3,$10,$11,$11) RETURNING id`,
        [a.title, sellerIds[a.seller], a.category, a.location, RICH[a.key].description, RICH[a.key].inspection, TERMS_HTML[TERMS_KEY[a.key]], startsAt, endsAt,
          a.phase !== 'upcoming', new Date(Math.min(startsAt.getTime(), now) - 4 * DAY)]
      );

      for (let i = 0; i < a.lots.length; i++) {
        const [title, , quantity, unit, start, inc, reserve] = a.lots[i];
        const closed = a.phase === 'closed';
        const lot = await q(
          `INSERT INTO lots(auction_id, lot_no, title, description, quantity, unit, start_price, increment, reserve_price, ends_at, status, specs)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
          [auction.id, i + 1, title, RICH[a.key].lots[i][0], quantity, unit, start, inc, reserve, endsAt, closed ? 'closed' : 'open', JSON.stringify(RICH[a.key].lots[i][1])]
        );
        const l = { id: lot.id, start, inc };

        if (a.phase === 'live') {
          // Leave one lot per live auction without bids so that state can be reviewed too.
          if (i === a.lots.length - 1) continue;
          await addBids(l, 3 + Math.floor(rand() * 6), now - 19 * MIN, now - MIN / 2);
        } else if (closed) {
          const result = a.results[i];
          if (result === 'no_bids') {
            await c.query(`UPDATE lots SET result = 'no_bids' WHERE id = $1`, [l.id]);
            continue;
          }
          const top = await addBids(l, 4 + Math.floor(rand() * 5), startsAt.getTime() + 5 * MIN, endsAt.getTime() - MIN);
          await c.query('UPDATE lots SET result = $2, winning_bid_id = $3, result_note = $4 WHERE id = $1',
            [l.id, result, top, result === 'awarded' ? 'Approved by seller.' : '']);
        }
      }
    }

    // Enquiries, only if none exist yet.
    if (!(await c.query('SELECT 1 FROM enquiries LIMIT 1')).rowCount) {
      await c.query(
        `INSERT INTO enquiries(name, email, phone, company, message, created_at) VALUES
         ('Deepak Malhotra', 'deepak@demo.kasturi.local', '+91 98111 40762', 'Malhotra Engineering Works',
          $1, $3),
         ('Neha Iyer', 'neha@demo.kasturi.local', '+91 99001 58823', 'Coastal Packaging Pvt Ltd',
          $2, $4)`,
        [
          'We have about 30 MT of MS scrap and two old power presses at our Faridabad unit. Please let us know how we can list them in an auction and what your charges are.',
          'I registered last week and uploaded our GST certificate, but the status still shows under review. Can you check and tell me if anything else is needed?',
          at(-2 * DAY), at(-5 * 60 * MIN),
        ]
      );
    }
    return true;
  });
  if (created) console.log('[seed] Demo data created (bidders trader1..trader8@demo.kasturi.local, password demo12345)');
}

/** Seed defaults. Safe to run on every boot. */
async function run() {
  await seedTemplates();
  await seedPages();
  await seedAdmin();
  await seedDemo();
  await upgradeDemo();
}

module.exports = { run, PAGES };
