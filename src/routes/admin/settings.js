// Settings page, rendered entirely from settings.DEFS.
const express = require('express');
const settings = require('../../lib/settings');
const { clean, isEmail } = require('../../lib/util');
const { wrap, audit } = require('../../middleware');
const { integrations } = require('./integrations');

const router = express.Router();

function groups() {
  const out = [];
  for (const d of settings.DEFS) {
    let g = out.find((x) => x.name === d.group);
    if (!g) out.push((g = { name: d.group, defs: [] }));
    g.defs.push(d);
  }
  return out;
}

const render = (res, values, errors = {}) => res.adminPage('admin/settings', {
  title: 'Settings', groups: groups(), values, errors, intg: integrations(), scripts: ['/js/admin.js'],
});

router.get('/settings', (req, res) => render(res, settings.all()));

router.post('/settings', wrap(async (req, res) => {
  const values = {};
  const errors = {};
  for (const d of settings.DEFS) {
    const raw = req.body[d.key];
    if (d.type === 'bool') {
      // Unchecked boxes are not sent at all, so absence means off.
      values[d.key] = [].concat(raw || []).includes('1') ? '1' : '0';
    } else if (d.type === 'number') {
      const s = String(raw ?? '').trim().replace(/,/g, '');
      values[d.key] = s;
      if (!/^\d+(\.\d+)?$/.test(s)) errors[d.key] = 'Enter a number, 0 or more.';
    } else if (d.type === 'email') {
      values[d.key] = clean(raw, 200);
      if (values[d.key] && !isEmail(values[d.key])) errors[d.key] = 'Enter a valid email address, or leave it empty.';
    } else {
      values[d.key] = clean(raw, d.type === 'textarea' ? 4000 : 500);
    }
  }
  if (!values.site_name) errors.site_name = 'Enter the site name. It appears in the header and in every email.';
  if (Object.keys(errors).length) {
    res.locals.flash = [{ type: 'error', text: `${Object.keys(errors).length === 1 ? 'One setting needs' : Object.keys(errors).length + ' settings need'} attention. Nothing was saved.` }];
    return render(res.status(400), values, errors);
  }
  const before = settings.all();
  const changed = settings.DEFS.filter((d) => String(before[d.key]) !== String(values[d.key])).map((d) => d.key);
  await settings.save(values);
  audit(req, 'settings.update', changed.join(', ') || 'no changes');
  req.flash('ok', changed.length ? `Settings saved (${changed.length} changed).` : 'Settings saved. Nothing had changed.');
  res.redirect('/admin/settings');
}));

module.exports = router;
