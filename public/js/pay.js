// Registration fee checkout (account/fee page). Opens Razorpay Checkout, then confirms the
// payment with the server, which also activates the fee.
(function () {
  var btn = document.getElementById('pay-btn');
  var msg = document.getElementById('pay-msg');
  if (!btn) return;
  var label = btn.textContent;
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

  function show(text, kind) {
    msg.textContent = text;
    msg.className = 'notice' + (kind ? ' notice-' + kind : '');
  }
  function busy(on, text) {
    btn.disabled = on;
    btn.textContent = on ? text : label;
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
        return data;
      });
    });
  }

  btn.addEventListener('click', function () {
    if (typeof window.Razorpay !== 'function') {
      show('The payment window could not load. Check your connection or disable any ad blocker for this site, then reload the page.', 'error');
      return;
    }
    busy(true, 'Starting payment');
    show('', ''); msg.classList.add('hide');
    post('/account/fee/order').then(function (o) {
      var rzp = new window.Razorpay({
        key: o.key,
        amount: o.amount,
        currency: o.currency || 'INR',
        order_id: o.orderId,
        name: o.siteName,
        description: 'Bidder registration fee',
        prefill: { name: o.name, email: o.email, contact: o.phone },
        theme: { color: '#0f2136' },
        handler: function (resp) {
          busy(true, 'Confirming payment');
          show('Payment made. Confirming it with the bank, do not close this page.', 'warn');
          post('/account/fee/verify', {
            razorpay_order_id: resp.razorpay_order_id,
            razorpay_payment_id: resp.razorpay_payment_id,
            razorpay_signature: resp.razorpay_signature
          }).then(function () {
            window.location.href = '/account/fee';
          }).catch(function (e) {
            busy(false);
            show(e.message, 'error');
          });
        },
        modal: {
          ondismiss: function () {
            busy(false);
            show('Payment window closed. No money was taken. Select the button again when you are ready.', '');
          }
        }
      });
      rzp.on('payment.failed', function (r) {
        var d = (r && r.error && r.error.description) || 'The payment did not go through.';
        busy(false);
        show(d + ' No money was taken. You can try again with another payment method.', 'error');
      });
      rzp.open();
    }).catch(function (e) {
      busy(false);
      show(e.message, 'error');
    });
  });
})();
