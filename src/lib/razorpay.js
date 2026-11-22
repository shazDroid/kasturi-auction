/**
 * Minimal Razorpay client: create orders and verify signatures. Uses the REST API directly
 * (no SDK) with HTTP Basic auth.
 */
const crypto = require('crypto');

const API = 'https://api.razorpay.com/v1';

const configured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

/**
 * Create an order for Razorpay Checkout. amountPaise is an integer number of paise.
 * Returns { id, amount, currency }. Throws with Razorpay's error description on failure.
 */
async function createOrder({ amountPaise, receipt, notes }) {
  if (!configured()) throw new Error('Online payments are not configured');
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    // Razorpay limits receipt to 40 characters.
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: String(receipt || '').slice(0, 40), notes: notes || {} }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.description) || `Razorpay returned HTTP ${res.status}`;
    throw new Error(msg);
  }
  return { id: body.id, amount: body.amount, currency: body.currency };
}

/** Constant-time comparison of two hex strings; false if lengths differ. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/** Verify the signature Razorpay Checkout returns to the browser after a successful payment. */
function verifyCheckout({ orderId, paymentId, signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId) return false;
  return safeEqual(hmac(secret, `${orderId}|${paymentId}`), signature);
}

/** Verify the x-razorpay-signature header of a webhook against the raw request body. */
function verifyWebhook(rawBody, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody) return false;
  return safeEqual(hmac(secret, rawBody), signatureHeader);
}

module.exports = { configured, createOrder, verifyCheckout, verifyWebhook };
