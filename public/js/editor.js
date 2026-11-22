// Rich text editor for admin forms. Enhances every <textarea data-rich> with Quill 2 (snow theme).
// The textarea stays in the form: its value is replaced with the editor HTML on submit, and the
// server sanitises it again before saving. Without JS (or if Quill fails to load) the plain
// textarea keeps working.
//
// Attributes on the textarea:
//   data-rich               turn the editor on
//   data-label-id="x"       id of the visible label, used as the editor's accessible name
//   data-placeholder="..."  placeholder text inside the empty editor
//   data-rich-source        offer an "Edit HTML" switch (CMS pages)
//   data-rich-tall          taller editor
(function () {
  if (typeof window.Quill !== 'function') return;
  var MAX = 100000;

  var TOOLBAR = [
    [{ header: [2, 3, false] }],
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link', 'blockquote'],
    ['clean'],
  ];
  // Labels for the toolbar buttons, which Quill renders as icons without text.
  var LABELS = {
    'ql-bold': 'Bold', 'ql-italic': 'Italic', 'ql-underline': 'Underline', 'ql-link': 'Link',
    'ql-blockquote': 'Quote', 'ql-clean': 'Clear formatting',
  };

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Old plain-text values: blank lines separate paragraphs, single newlines become line breaks. */
  function plainToHtml(text) {
    return text.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean)
      .map(function (p) { return '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  // Things the editor cannot show; a page containing them opens in HTML mode so nothing is lost.
  var UNSUPPORTED = /<(table|hr|img|iframe|div|section|figure|h1|h5|h6|pre|code|dl)\b/i;

  function enhance(ta, n) {
    var initial = ta.value.trim();
    var html = !initial ? '' : initial.charAt(0) === '<' ? initial : plainToHtml(initial);
    var allowSource = ta.hasAttribute('data-rich-source');

    var wrap = document.createElement('div');
    wrap.className = 'ax-editor' + (ta.hasAttribute('data-rich-tall') ? ' ax-editor-tall' : '');
    var host = document.createElement('div');
    wrap.appendChild(host);
    ta.parentNode.insertBefore(wrap, ta.nextSibling);

    var quill = new window.Quill(host, {
      theme: 'snow',
      placeholder: ta.getAttribute('data-placeholder') || '',
      formats: ['header', 'bold', 'italic', 'underline', 'list', 'indent', 'link', 'blockquote'],
      modules: {
        toolbar: TOOLBAR,
        clipboard: { matchVisual: false },
        keyboard: {
          // Keep Tab for moving between fields (Tab at the start of a list item still nests it).
          bindings: { tab: null, 'remove tab': null, 'indent code-block': null, 'outdent code-block': null, 'table tab': null },
        },
      },
    });
    if (html) quill.setContents(quill.clipboard.convert({ html: html, text: '' }), 'silent');
    quill.history.clear();

    // Accessibility: name the editing area after the field label, and label the icon buttons.
    var root = quill.root;
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    var labelId = ta.getAttribute('data-label-id');
    if (labelId) root.setAttribute('aria-labelledby', labelId);
    var describedBy = [];
    var field = ta.closest('.field');
    if (field) {
      field.querySelectorAll('.hint, .err').forEach(function (el, i) {
        if (!el.id) el.id = 'rich-' + n + '-d' + i;
        describedBy.push(el.id);
      });
    }
    if (describedBy.length) root.setAttribute('aria-describedby', describedBy.join(' '));
    if (field && field.querySelector('.err')) wrap.classList.add('is-invalid');
    var toolbar = wrap.querySelector('.ql-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Formatting');
    toolbar.querySelectorAll('button').forEach(function (b) {
      var label = LABELS[b.className.split(' ')[0]];
      if (b.classList.contains('ql-list')) label = b.value === 'ordered' ? 'Numbered list' : 'Bulleted list';
      if (label) { b.setAttribute('aria-label', label); b.setAttribute('title', label); }
    });
    var picker = toolbar.querySelector('.ql-header .ql-picker-label');
    if (picker) picker.setAttribute('aria-label', 'Text style');
    var label = labelId && document.getElementById(labelId);
    if (label && label.tagName === 'LABEL') label.addEventListener('click', function (e) { e.preventDefault(); quill.focus(); });

    // Optional HTML source mode for pages.
    var source = false;
    var toggle = null;
    var note = document.createElement('p');
    note.className = 'ax-editor-note hint';
    function setSource(on) {
      source = on;
      if (on) { ta.value = currentHtml(); }
      else { quill.setContents(quill.clipboard.convert({ html: ta.value, text: '' }), 'user'); }
      ta.classList.toggle('hide', !on);
      wrap.classList.toggle('hide', on);
      if (toggle) toggle.textContent = on ? 'Back to the editor' : 'Edit HTML';
      if (on) ta.focus(); else quill.focus();
    }
    if (allowSource) {
      var bar = document.createElement('div');
      bar.className = 'ax-editor-switch';
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'linkbtn';
      toggle.textContent = 'Edit HTML';
      toggle.addEventListener('click', function () {
        if (!source) return setSource(true);
        if (UNSUPPORTED.test(ta.value) && !window.confirm('The HTML contains a table or other layout the editor cannot show. Switching back removes it. Switch anyway?')) return;
        setSource(false);
      });
      bar.appendChild(toggle);
      bar.appendChild(note);
      ta.parentNode.insertBefore(bar, ta);
    }

    ta.classList.add('hide');
    if (allowSource && UNSUPPORTED.test(html)) {
      note.textContent = 'This page contains a table or other layout that the editor cannot show, so it is open as HTML.';
      ta.value = initial;
      source = true;
      ta.classList.remove('hide');
      wrap.classList.add('hide');
      toggle.textContent = 'Back to the editor';
    }

    function currentHtml() {
      if (quill.getText().trim() === '' && !root.querySelector('li')) return '';
      // Quill 2.0.3 writes every space as &nbsp; in semantic HTML; plain spaces are what we store.
      return quill.getSemanticHTML().replace(/&nbsp;/g, ' ').replace(/ /g, ' ');
    }

    var form = ta.form;
    if (form) {
      form.addEventListener('submit', function (e) {
        // Submits that go to another form (photo buttons with form="...") never reach here.
        if (!source) ta.value = currentHtml();
        var old = wrap.parentNode.querySelector('.ax-editor-size');
        if (old) old.remove();
        if (ta.value.length > MAX) {
          e.preventDefault();
          e.stopImmediatePropagation();
          var msg = document.createElement('div');
          msg.className = 'err ax-editor-size';
          msg.setAttribute('role', 'alert');
          msg.textContent = 'This text is too long (' + ta.value.length.toLocaleString('en-IN') + ' characters including formatting). Shorten it to under 100,000 characters, or upload long annexures as a PDF document.';
          wrap.parentNode.insertBefore(msg, wrap.nextSibling);
          wrap.classList.add('is-invalid');
          if (source) ta.focus(); else quill.focus();
        }
      });
    }
  }

  document.querySelectorAll('textarea[data-rich]').forEach(function (ta, i) {
    try { enhance(ta, i); } catch (err) { ta.classList.remove('hide'); }
  });
})();
