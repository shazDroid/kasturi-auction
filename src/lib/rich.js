const sanitizeHtml = require('sanitize-html');
const { nl2p } = require('./util');

const OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'blockquote', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  allowedAttributes: { a: ['href', 'target', 'rel'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: {
    h1: 'h2',
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

/** Clean HTML from the admin rich text editor before saving. Returns '' for an empty document. */
function sanitize(html) {
  const out = sanitizeHtml(String(html || ''), OPTIONS).trim();
  return out.replace(/<p>(\s|<br\s*\/?>)*<\/p>/g, '').trim() ? out : '';
}

/**
 * Stored description -> safe HTML for a view. Rich text (saved by the editor) is sanitised again
 * on the way out; older plain-text values become paragraphs.
 */
function render(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return /^<(p|h[2-4]|ul|ol|table|blockquote|hr)\b/i.test(s) ? sanitizeHtml(s, OPTIONS) : nl2p(s);
}

/** Plain-text excerpt of a description, for cards and meta tags. */
function excerpt(value, max = 160) {
  const t = sanitizeHtml(String(value || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

module.exports = { sanitize, render, excerpt };
