/**
 * Razorpay webhook. server.js mounts express.raw() for this path, so req.body is the raw Buffer
 * that Razorpay signed. This is the reliable path for marking fees paid: it still works when the
 * bidder closes the browser before the checkout callback reaches us.
 */
const express = require('express');
const db = require('../db');
const razorpay = require('../lib/razorpay');
const payments = require('../lib/payments');

const router = express.Router();

router.post('/payments/webhook', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!razorpay.verifyWebhook(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ ok: false, error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  try {
    const payload = event.payload || {};
    const payment = (payload.payment && payload.payment.entity) || {};
    const orderId = payment.order_id || (payload.order && payload.order.entity && payload.order.entity.id);

    if ((event.event === 'payment.captured' || event.event === 'order.paid') && orderId) {
      // Idempotent: the checkout callback and both events may arrive for the same order.
      await payments.markPaidByOrder(orderId, payment.id || '');
    } else if (event.event === 'payment.failed' && orderId) {
      // A failed attempt must never overwrite a payment that already succeeded.
      await db.query(`UPDATE payments SET status = 'failed' WHERE rp_order_id = $1 AND status = 'created'`, [orderId]);
    }
    // Unknown or irrelevant events are acknowledged so Razorpay does not keep retrying them.
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] razorpay', event && event.event, e);
    res.status(500).json({ ok: false }); // non-2xx makes Razorpay retry later
  }
});

module.exports = router;
