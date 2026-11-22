// Which external services are configured. Reports yes/no and env var names only, never values.
const mailer = require('../../lib/mailer');
const razorpay = require('../../lib/razorpay');

const has = (k) => !!String(process.env[k] || '').trim();

function integrations() {
  const transport = mailer.transportName();
  return {
    razorpay: { ok: razorpay.configured(), keys: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] },
    webhook: { ok: has('RAZORPAY_WEBHOOK_SECRET'), keys: ['RAZORPAY_WEBHOOK_SECRET'] },
    mail: {
      ok: transport !== 'none',
      transport,
      keys: ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'],
      envHint: 'BREVO_API_KEY (Brevo), or SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS (any SMTP server)',
    },
    baseUrl: { ok: has('BASE_URL'), keys: ['BASE_URL'] },
    siteUrl: mailer.url(''),
    webhookUrl: mailer.url('/payments/webhook'),
  };
}

module.exports = { integrations };
