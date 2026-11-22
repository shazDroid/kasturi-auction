// Photo gallery: thumbnail strip, and a full-screen lightbox (<dialog>) with previous/next,
// arrow keys and Escape. Markup comes from views/site/lot.ejs (lot photos) and auction.ejs (auction
// photos in the banner); every [data-gallery] on the page is set up. Without JavaScript the first photo shows.
document.querySelectorAll('[data-gallery]').forEach(function (g) {
  var items = Array.prototype.slice.call(g.querySelectorAll('[data-full]'));
  if (!items.length) return;
  var mainBtn = g.querySelector('.js-gallery-open');
  var mainImg = g.querySelector('.js-gallery-img');
  var dlg = g.querySelector('dialog.lightbox');
  var lbImg = dlg && dlg.querySelector('.js-lb-img');
  var lbCount = dlg && dlg.querySelector('.js-lb-count');
  var baseAlt = mainImg ? mainImg.getAttribute('alt').replace(/, photo \d+ of \d+$/, '') : 'Photo';
  var n = items.length;
  var current = 0;

  function select(i) {
    current = (i + n) % n;
    var it = items[current];
    if (mainImg) {
      mainImg.src = it.getAttribute('data-full');
      if (it.getAttribute('data-w')) { mainImg.width = Number(it.getAttribute('data-w')); mainImg.height = Number(it.getAttribute('data-h')); }
      mainImg.alt = baseAlt + ', photo ' + (current + 1) + ' of ' + n;
    }
    if (mainBtn) mainBtn.setAttribute('aria-label', 'Open photo ' + (current + 1) + ' of ' + n + ' full screen');
    items.forEach(function (b, k) { if (b.tagName === 'BUTTON') b.setAttribute('aria-current', k === current ? 'true' : 'false'); });
    if (dlg && dlg.open) paintLightbox();
  }

  function paintLightbox() {
    lbImg.src = items[current].getAttribute('data-full');
    lbImg.alt = baseAlt + ', photo ' + (current + 1) + ' of ' + n;
    lbCount.textContent = 'Photo ' + (current + 1) + ' of ' + n;
  }

  g.addEventListener('click', function (e) {
    var t = e.target.closest('.gallery-thumbs [data-index]');
    if (t) { select(Number(t.getAttribute('data-index'))); return; }
    if (e.target.closest('.js-gallery-open') && dlg && typeof dlg.showModal === 'function') {
      paintLightbox();
      dlg.showModal();
      var close = dlg.querySelector('.js-lb-close');
      if (close) close.focus();
    }
  });

  // Arrow keys move through the thumbnail strip as well.
  var strip = g.querySelector('.gallery-thumbs');
  if (strip) strip.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    select(current + (e.key === 'ArrowRight' ? 1 : -1));
    items[current].focus();
  });

  if (!dlg) return;
  dlg.querySelector('.js-lb-close').addEventListener('click', function () { dlg.close(); });
  dlg.querySelector('.js-lb-prev').addEventListener('click', function () { select(current - 1); });
  dlg.querySelector('.js-lb-next').addEventListener('click', function () { select(current + 1); });
  dlg.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); select(current + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); select(current - 1); }
  });
  // A click on the dark area around the photo closes the lightbox.
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg || e.target.classList.contains('lb-stage')) dlg.close();
  });
  dlg.addEventListener('close', function () { if (mainBtn) mainBtn.focus(); });
});
