// Changes to a document made in the page's schedule editor. Each call checks
// the new value against its format, keeps the document's own findings in step,
// and counts the edit, so the page can re-run the rules and warn before leaving.
//
//   BSPV.edit.setValue(spec, doc, { form, table, cell, item }, raw)  -> error text or null
//   BSPV.edit.setField(spec, doc, form, field, raw)                  -> error text or null
//   BSPV.edit.setHeader(spec, doc, name, raw, quiet)                 -> error text or null
//     (quiet: copying the page's period fields into a template; not counted as an edit)
//   BSPV.edit.addItem(spec, doc, form, table)                        -> new entry number
//   BSPV.edit.removeItem(spec, doc, form, table, index)
(function (root, factory) {
  var api;
  if (typeof module !== 'undefined' && module.exports) api = module.exports = factory(require('./engine.js'), require('./spec.js'));
  else api = factory(root.BSPV.engine, root.BSPV.spec);
  (root.BSPV = root.BSPV || {}).edit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ENGINE, SPEC) {
  'use strict';

  function instance(spec, doc, formName) {
    var form = spec.formByName[formName];
    if (!form || !form.x) throw new Error(formName + ' is not a schedule of the file.');
    if (!doc.forms[formName] || !doc.forms[formName].length) doc.forms[formName] = [{ name: formName, fields: {}, tables: {} }];
    return { form: form, inst: doc.forms[formName][0] };
  }

  function tableData(form, inst, tableName) {
    var t = form.tableByName[tableName];
    if (!t || !t.x) throw new Error(form.n + ' / ' + tableName + ' is not a table of the file.');
    if (!inst.tables[tableName]) inst.tables[tableName] = t.k === 'S' ? { cells: {} } : { items: [] };
    return { t: t, data: inst.tables[tableName] };
  }

  function same(f, at) {
    return f.form === at.form && (f.table || null) === (at.table || null) && f.cell === at.cell &&
      (f.item === undefined ? null : f.item) === (at.item === undefined || at.item === null ? null : at.item);
  }

  // Stores one value. An empty value removes the cell. Returns the format
  // problem as text, or null; a bad value is kept as typed so it can be fixed.
  function store(doc, holder, key, type, raw, at, label, quiet) {
    doc.findings = doc.findings.filter(function (f) { return !(f.kind === 'file' && /^(XSD-TYPE|TPL-ERROR-VALUE|XSD-REQUIRED)$/.test(f.code) && same(f, at)); });
    if (!quiet) doc.edited = (doc.edited || 0) + 1;
    var text = raw === null || raw === undefined ? '' : String(raw);
    if (type.b !== 's') text = text.trim();
    // typed on the page, 1,234,567.89 means 1234567.89
    if ((type.b === 'd' || type.b === 'i') && /^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(text)) text = text.replace(/,/g, '');
    var old = holder[key];
    if (text === '') { delete holder[key]; return null; }
    var r = ENGINE.checkValue(type, text);
    var rec = { raw: text, v: r.err ? null : r.v, edited: true };
    if (old && old.loc) rec.loc = old.loc;
    if (r.err) {
      rec.bad = true;
      var f = { sev: 'error', code: 'XSD-TYPE', kind: 'file', msg: label + ': "' + text.slice(0, 60) + '" ' + r.err + '.', loc: rec.loc };
      Object.keys(at).forEach(function (k) { if (at[k] !== undefined && at[k] !== null) f[k] = at[k]; });
      doc.findings.push(f);
    }
    holder[key] = rec;
    return r.err || null;
  }

  function typeOf(spec, def) { return spec.types[Array.isArray(def[1]) ? def[1][0] : def[1]]; }

  function setValue(spec, doc, at, raw) {
    var x = instance(spec, doc, at.form), td = tableData(x.form, x.inst, at.table);
    var def = td.t.c[at.cell];
    if (!def || def[0] !== 0) throw new Error(at.form + ' / ' + at.table + ' / ' + at.cell + ' is worked out by the BSP; it cannot be typed in.');
    var cells;
    if (td.t.k === 'S') {
      cells = td.data.cells;
    } else {
      var it = td.data.items[at.item];
      if (!it) throw new Error('There is no entry ' + (Number(at.item) + 1) + ' in ' + at.form + ' / ' + at.table + '.');
      cells = it.cells;
    }
    var label = at.form + ' / ' + at.table + (td.t.k === 'S' ? '' : ' entry ' + (Number(at.item) + 1)) + ' / ' + at.cell;
    return store(doc, cells, at.cell, typeOf(spec, def), raw, { form: at.form, table: at.table, cell: at.cell, item: td.t.k === 'S' ? undefined : Number(at.item) }, label);
  }

  function setField(spec, doc, formName, field, raw) {
    var x = instance(spec, doc, formName);
    var f = x.form.fieldByName[field] || (x.form.z && x.form.z.f === field ? [x.form.z.f, x.form.z.ty] : null);
    if (!f) throw new Error(formName + ' has no field ' + field + '.');
    return store(doc, x.inst.fields, field, spec.types[f[1]], raw, { form: formName, cell: field }, formName + ' / ' + field);
  }

  function setHeader(spec, doc, name, raw, quiet) {
    var h = spec.header.filter(function (x) { return x[0] === name; })[0];
    if (!h) throw new Error('The header has no field ' + name + '.');
    doc.findings = doc.findings.filter(function (f) { return !(f.form === 'Header' && f.cell === name) && !(f.code === 'XSD-HEADER' && new RegExp('\\b' + name + '\\b').test(f.msg)); });
    var err = store(doc, doc.header, name, spec.types[h[1]], raw, { form: 'Header', cell: name }, 'Header / ' + name, quiet);
    if (!doc.header[name]) {
      doc.findings.push({ sev: 'error', code: 'XSD-HEADER', kind: 'file', form: 'Header', cell: name, msg: 'Header / ' + name + ' is not filled in. It is required.' });
    }
    return err;
  }

  function addItem(spec, doc, formName, tableName) {
    var x = instance(spec, doc, formName), td = tableData(x.form, x.inst, tableName);
    if (td.t.k === 'S') throw new Error(tableName + ' is not a list.');
    td.data.items.push({ index: td.data.items.length, cells: {} });
    doc.edited = (doc.edited || 0) + 1;
    return td.data.items.length - 1;
  }

  function removeItem(spec, doc, formName, tableName, index) {
    var x = instance(spec, doc, formName), td = tableData(x.form, x.inst, tableName);
    td.data.items.splice(index, 1);
    td.data.items.forEach(function (it, i) {
      it.index = i;
      Object.keys(it.cells).forEach(function (c) { if (it.cells[c].item !== undefined) it.cells[c].item = i; });
    });
    doc.findings = doc.findings.filter(function (f) {
      if (f.form !== formName || f.table !== tableName || f.item === undefined) return true;
      if (f.item === index) return false;
      if (f.item > index) f.item--;
      return true;
    });
    doc.edited = (doc.edited || 0) + 1;
  }

  return { setValue: setValue, setField: setField, setHeader: setHeader, addItem: addItem, removeItem: removeItem, label: SPEC.cellLabel };
});
