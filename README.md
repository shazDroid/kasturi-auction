# Kasturi Auction

An online forward auction platform for industrial scrap and surplus material, for the Indian B2B market. Sellers' lots are published as timed auctions; registered and document-checked buyers bid live; the highest bid on each lot goes to the seller for approval, and the winner is notified by email. Payment for the material and lifting are handled directly between buyer and seller under each auction's terms.

Node.js 20+, Express 4, EJS, PostgreSQL, Socket.IO. There is no build step. All amounts are in INR and all times are shown in IST.

## Features

**Public site**
- Auction listing (live, upcoming, closed) and auction pages with lots, quantities, start prices, inspection details and terms.
- Editable content pages: About us, How it works, Terms of use, Privacy policy.
- Contact form; enquiries are stored, acknowledged by email and forwarded to the admin alert address.
- Option to hide lots and prices from visitors who are not signed in.

**Bidder portal**
- Registration, email verification and password reset.
- Business details and document upload (GST certificate, PAN, address proof; the list is configurable) for admin review.
- Registration fee paid online through Razorpay, with an emailed receipt.
- A checklist showing what is still needed before bidding, and a list of the bidder's bids and results.
- Option to stop auction announcement emails.

**Live bidding rules**
- Each bid must be at least the current highest bid plus the lot's increment (or the start price for the first bid).
- A bid in the last few minutes of a lot extends that lot's close (window and extension length are set per auction).
- Lots in an auction can close together or staggered a few minutes apart.
- Equal amounts: the earlier bid ranks higher. A configurable cap blocks accidental oversized jumps, such as an extra zero.
- Bids are validated inside a database transaction with a row lock, so simultaneous bids are handled in order.
- Prices update live over WebSockets. Bidders never see other bidders' identities. The highest bid can be hidden per auction.
- When a lot closes, the highest bid is marked pending for seller approval, or awarded automatically if the auction allows it and the reserve price is met.

**Admin panel**
- Auctions, lots, sellers, bidders, document approval, bid cancellation, lot decisions (award or reject).
- Payments, including recording offline payments (bank transfer, cheque).
- Email templates, email log, content pages, enquiries, site settings, admin users and an audit log.
- Two roles: super admin and staff.

**Email**
- Fourteen admin-editable templates (verification, password reset, document decisions, fee receipt, auction announcement and reminder, outbid, lot awarded, enquiries, admin alerts) with `{{placeholders}}`.
- One plain, table-based layout that renders correctly in Gmail and Outlook.
- Mail is queued in the database and sent by a background worker with up to 3 attempts. Every message is visible in the admin email log.
- Delivery through the Brevo HTTP API or any SMTP server.

**Registration fee**
- Fee amount, GST percentage and validity period are set in admin settings, or the fee can be switched off.
- Payment through Razorpay Checkout. The payment is confirmed both from the browser callback and from a signed Razorpay webhook, so a bidder who closes the window after paying is still marked paid.

## Local setup

Requirements: Node.js 20 or later, PostgreSQL 13 or later.

```sh
npm install
createdb kasturi                      # or: psql -c 'CREATE DATABASE kasturi'
cp .env.example .env                  # then edit DATABASE_URL and the rest
node --env-file=.env src/server.js    # or export the variables and run: npm start
```

Open http://localhost:3000. The schema is created automatically on every start (it is idempotent), followed by default email templates, content pages and the first admin account.

Without `ADMIN_EMAIL` and `ADMIN_PASSWORD`, outside production, a development admin is created: `admin@kasturi.local` with password `admin12345`. The admin panel is at `/admin`.

To review the interface with sample data, set `SEED_DEMO=true` before the first start (it only runs when there are no auctions). It creates four sellers, seven auctions (two live, three upcoming, two closed) with lots and bids, and demo bidders `trader1@demo.kasturi.local` to `trader8@demo.kasturi.local`, password `demo12345`. Bidders 1 to 6 can bid; 7 has documents under review; 8 has not completed registration. Demo bidders have auction emails turned off. Do not use demo data on the live site.

Without a mail provider, emails are not sent; they are recorded in the email log as skipped, and in development the recipient and subject are printed to the console.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `DATABASE_SSL` | No | `true` if the database requires SSL (for example a Render external URL). Not needed for local or Render internal URLs. |
| `NODE_ENV` | Production | `production` enables secure cookies and requires `SESSION_SECRET`. |
| `PORT` | No | Listening port. Default 3000. Render sets it. |
| `SESSION_SECRET` | Production | Long random string for signing session cookies. |
| `BASE_URL` | Recommended | Public site address used in email links, without a trailing slash, for example `https://auction.example.com`. Falls back to `RENDER_EXTERNAL_URL`, then `http://localhost:PORT`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First boot | Creates the first super admin if no admin exists. Password at least 8 characters. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | For online fee | Razorpay API keys. |
| `RAZORPAY_WEBHOOK_SECRET` | For online fee | Secret entered when creating the Razorpay webhook. Webhooks are rejected without it. |
| `BREVO_API_KEY` | One mail option | Sends mail through the Brevo HTTP API. Takes priority over SMTP. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Other mail option | Any SMTP server. Port 587 (STARTTLS, default) or 465 (SSL). |
| `SEED_DEMO` | No | `true` creates demo data on a database with no auctions. |

Business details, fee amount, bidding defaults, sender name and address, and email footer are set in the admin panel under Settings, not in environment variables.

## Deploying to Render

The repository contains a Blueprint (`render.yaml`) that creates the web service and the database together.

1. Push this repository to GitHub or GitLab.
2. In the Render dashboard choose **New > Blueprint** and select the repository. Render reads `render.yaml` and shows a web service `kasturi-auction` and a database `kasturi-auction-db`.
3. Fill in the variables Render asks for. At minimum set `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Leave the others empty for now if you do not have them yet; you can add them later under the service's **Environment** tab. `DATABASE_URL` and `SESSION_SECRET` are filled in automatically.
4. Apply the Blueprint. The first deploy installs dependencies, creates the tables and the admin account, and starts the service. Check the deploy log for `Kasturi Auction listening`.
5. Open the service URL, go to `/admin` and sign in.
6. If you use your own domain, add it under the service's **Settings > Custom Domains**, then set `BASE_URL` to `https://your-domain` so links in emails point to it.

Points to know about Render's free plan (check Render's current documentation before relying on it):
- A free web service stops after 15 minutes without traffic and takes about a minute to start again. While it is stopped, lots are not closed and the email queue is not processed; both catch up when it starts. For live auctions use a paid instance.
- A free PostgreSQL database expires 30 days after it is created and has no backups. Upgrade the database before putting real data in it.
- Free web services cannot connect to outbound SMTP ports 25, 465 and 587, so use the Brevo API option for email there.

## Setting up the Razorpay webhook

1. In the Razorpay dashboard, go to **Account & Settings > Webhooks** (in test mode first, then again in live mode).
2. Add a webhook with URL `https://your-domain/payments/webhook`.
3. Enter a secret (a long random string) and save the same value as `RAZORPAY_WEBHOOK_SECRET` on the server.
4. Select the events `payment.captured`, `order.paid` and `payment.failed`.
5. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from **Account & Settings > API Keys**.
6. Make a test payment with Razorpay test keys and check that the payment shows as paid in the admin panel and a receipt appears in the email log.

The webhook rejects requests with a missing or wrong signature (HTTP 400). Marking a payment paid is idempotent, so the browser callback and both events can arrive for the same order without extending the fee twice.

## Setting up email

Choose one provider:

- **Brevo HTTP API (recommended).** Create a Brevo account, verify your sending domain or sender address, create an API key under **SMTP & API > API Keys**, and set `BREVO_API_KEY`. This uses HTTPS, so it works on hosts that restrict outbound SMTP ports.
- **SMTP.** Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` for any provider (Brevo SMTP relay, Amazon SES, Zoho, Google Workspace). Some hosts, including Render's free plan, block outbound SMTP ports, so the HTTP API option is the safer choice.

Then, in the admin panel under **Settings > Email**, set the sender name and a sender email address that your provider allows you to send from, and the address for admin alerts. To improve delivery, add the SPF and DKIM records your provider gives you to your domain's DNS.

## First admin login

1. Sign in at `/admin` with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The account is only created when no admin exists, so changing these variables later has no effect; change the password from the admin panel instead.
2. Go to **Settings** and enter the business details, contact email and phone, fee amount and GST, and email settings.
3. Review the content pages (About us, How it works, Terms of use, Privacy policy).
4. Review the email templates.
5. Add staff accounts if needed, then add sellers and your first auction.

## Going live checklist

- [ ] Database is on a paid plan with backups.
- [ ] Web service is on a paid instance so it does not sleep during auctions.
- [ ] `NODE_ENV=production`, `SESSION_SECRET` set, `SEED_DEMO` not set or `false`.
- [ ] `BASE_URL` set to the final domain, served over HTTPS.
- [ ] Admin password changed from any temporary value; staff accounts have their own logins.
- [ ] Business details, contact email and phone, and email footer filled in under Settings.
- [ ] Terms of use and Privacy policy reviewed by your legal adviser and edited for your business. The included text is a starting draft only.
- [ ] Fee amount, GST and validity confirmed.
- [ ] Razorpay live keys set, live-mode webhook created, and one real payment tested end to end.
- [ ] Mail provider configured, sending domain verified (SPF and DKIM), and a test email received in Gmail and Outlook.
- [ ] Admin alert email address set.
- [ ] A complete test auction run: register a bidder, approve documents, pay the fee, bid from two accounts, let a lot close, award it, and check every email.
