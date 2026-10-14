// Writes a document as the XML submission file the report's schema describes,
// laid out like the files the BSP portal saves (tabs, CRLF, cells in row order).
// Used to turn a filled-in Excel input template into the file to send.
//
//   var out = BSPV.exporter.toXml(spec, doc, { now: new Date() });
//   out.problems   cells or header fields that cannot be written; no file then
//   out.rounded    amounts whose Excel rounding noise was dropped (98358232.8399999 -> 98358232.84)
//   out.xml, out.name
//
//   BSPV.exporter.toXlsx(spec, doc, { now }) -> Promise of { bytes, notes, name }
//   writes the same document as a workbook in the layout of the BSP input
//   template, every schedule on its own sheet plus a Header sheet, so it can be
//   edited in Excel and opened here again.
(function (root, factory) {
  var api;
  if (typeof module !== 'undefined' && module.exports) {
    api = module.exports = factory(require('./engine.js'), require('./xml.js'), require('./xlsxwrite.js'));
  } else {
    api = factory(root.BSPV.engine, root.BSPV.xml, root.BSPV.xlsxwrite);
  }
  (root.BSPV = root.BSPV || {}).exporter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ENGINE, XML, XLSXW) {
  'use strict';

  var NL = '\r\n', TAB = '\t';

  function typeOf(spec, def) { return spec.types[Array.isArray(def[1]) ? def[1][0] : def[1]]; }

  // The text of one value, or { problem }. A number that only failed because
  // of binary noise beyond its allowed decimals is rounded, and said so.
  function valueText(type, rec, where, out) {
    if (!rec.bad) return { text: type.b === 's' ? rec.raw : String(rec.raw).trim() };
    var raw = String(rec.raw).trim(), n = Number(raw);
    if ((type.b === 'd' || type.b === 'i') && raw !== '' && isFinite(n) && type.fd !== undefined) {
      var places = Number(type.fd), fixed = n.toFixed(places);
      if (Math.abs(n - Number(fixed)) < 5e-7 && !ENGINE.checkValue(type, fixed).err) {
        out.rounded.push({ where: where, from: raw, to: fixed });
        return { text: fixed };
      }
    }
    return { problem: where + ': "' + raw + '" ' + (ENGINE.checkValue(type, raw).err || 'cannot be written') + '.' };
  }

  function cellLines(spec, table, cells, indent, label, out) {
    var lines = [];
    Object.keys(table.c).forEach(function (code) {
      var def = table.c[code], rec = cells[code];
      if (!rec || def[0] !== 0) return;
      var where = label + ' / ' + code + (rec.loc ? ' (' + rec.loc + ')' : '');
      var r = valueText(typeOf(spec, def), rec, where, out);
      if (r.problem) { out.problems.push(r.problem); return; }
      lines.push(indent + '<' + code + '>' + XML.escape(r.text) + '</' + code + '>');
    });
    return lines;
  }

  function block(name, inner, indent) {
    return inner.length ? [indent + '<' + name + '>'].concat(inner, [indent + '</' + name + '>']) : [indent + '<' + name + '/>'];
  }

  function formBody(spec, form, inst, indent, out) {
    var lines = [];
    var fields = (form.z ? [[form.z.f, form.z.ty]] : []).concat(form.f || []);
    fields.forEach(function (f) {
      var rec = inst.fields[f[0]];
      if (!rec) return;
      var r = valueText(spec.types[f[1]], rec, form.n + ' / ' + f[0], out);
      if (r.problem) out.problems.push(r.problem);
      else lines.push(indent + '<' + f[0] + '>' + XML.escape(r.text) + '</' + f[0] + '>');
    });
    form.tb.forEach(function (t) {
      var data = inst.tables[t.n];
      if (!data || !t.x) return;
      var label = form.n + ' / ' + t.n;
      if (t.k === 'S') {
        lines = lines.concat(block(t.n, cellLines(spec, t, data.cells, indent + TAB, label, out), indent));
        return;
      }
      var items = [];
      data.items.forEach(function (it, i) {
        items = items.concat(block(t.item, cellLines(spec, t, it.cells, indent + TAB + TAB, label + ' entry ' + (i + 1), out), indent + TAB));
      });
      lines = lines.concat(block(t.n, items, indent));
    });
    return lines;
  }

  function stamp(d) {
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  }

  // REPORT[_Year_Period]_<bank>_<YYYY-MM-DD_HH-MM-SS>.<ext>, as the portal names its files
  function fileName(spec, doc, ext, now) {
    var h = doc.header, v = function (k) { return h[k] && !h[k].bad ? String(h[k].raw).trim() : ''; };
    var parts = [spec.report].concat(v('Year') && v('Period') ? [v('Year'), v('Period')] : [], v('Undertaking') ? [v('Undertaking')] : [], [stamp(now || new Date())]);
    return parts.join('_') + '.' + ext;
  }

  function toXml(spec, doc, opts) {
    opts = opts || {};
    var out = { problems: [], rounded: [], xml: null, name: null };
    if (doc.fatal) { out.problems.push('The file could not be read, so there is nothing to write.'); return out; }
    var header = [];
    spec.header.forEach(function (hd) {
      var rec = doc.header[hd[0]];
      if (!rec || rec.bad || rec.raw === undefined || String(rec.raw).trim() === '') {
        out.problems.push('Header / ' + hd[0] + ' is ' + (rec && rec.bad ? 'not valid: "' + rec.raw + '"' : 'not given') + '.');
        return;
      }
      header.push(TAB + TAB + '<' + hd[0] + '>' + XML.escape(String(rec.raw).trim()) + '</' + hd[0] + '>');
    });
    var lines = ['<?xml version="1.0" encoding="utf-8"?>', '<' + spec.root + ' xmlns="' + spec.ns + '">', TAB + '<Header>'].concat(header, [TAB + '</Header>']);
    spec.forms.forEach(function (form) {
      var list = doc.forms[form.n];
      if (!list || !form.x) return;
      if (form.z) {
        var items = [];
        list.forEach(function (inst) { items = items.concat(block(form.z.item, formBody(spec, form, inst, TAB + TAB + TAB, out), TAB + TAB)); });
        lines = lines.concat(block(form.n, items, TAB));
      } else {
        lines = lines.concat(block(form.n, formBody(spec, form, list[0], TAB + TAB, out), TAB));
      }
    });
    lines.push('</' + spec.root + '>');
    if (out.problems.length) return out;
    out.xml = lines.join(NL) + NL;
    out.name = fileName(spec, doc, 'xml', opts.now);
    return out;
  }

  // ---- workbook in the layout of the BSP input template ---------------------------

  // What goes in a workbook cell: numbers stay numbers, everything else is text.
  // A value that did not pass its format check is kept as typed, to be fixed there.
  function bookValue(type, rec) {
    if (!rec) return undefined;
    if (rec.bad) return String(rec.raw);
    if ((type.b === 'd' || type.b === 'i') && typeof rec.v === 'number') return rec.v;
    return String(rec.v === null || rec.v === undefined ? rec.raw : rec.v);
  }

  function inputStyle(type) {
    if (type.b === 'i' || (type.b === 'd' && Number(type.fd) === 0)) return 'count';
    if (type.b === 'd') return Number(type.fd) === 2 ? 'amount' : 'number';
    return 'text';
  }

  var BLANK_LIST_ROWS = 15;

  function formSheet(spec, form, inst, notes) {
    var rows = {}, maxCol = 5;
    function put(r, c, v, s) { (rows[r] = rows[r] || {})[c] = { v: v, s: s }; if (c > maxCol) maxCol = c; }
    function headerRows(r, labels, codes, first) {
      put(r, 2, 'Particulars', 'header'); put(r, 3, 'Account Code', 'header'); put(r, 4, '', 'header');
      put(r + 1, 2, '', 'code'); put(r + 1, 3, '', 'code'); put(r + 1, 4, '', 'code');
      labels.forEach(function (l, i) { put(r, first + i, l, 'header'); put(r + 1, first + i, codes[i], 'code'); });
    }
    put(1, 1, form.n, 'title');
    put(2, 1, form.t, 'subtitle');
    var r = 4;
    var fields = (form.z ? [[form.z.f, form.z.ty, form.z.t]] : []).concat(form.f || []);
    fields.forEach(function (f) {
      var type = spec.types[f[1]];
      put(r, 1, f[0], 'marker');
      put(r + 1, 1, f[2] || f[0], 'subtitle');
      put(r + 2, 1, inst ? bookValue(type, inst.fields[f[0]]) : undefined, inputStyle(type));
      r += 4;
    });
    form.tb.forEach(function (t) {
      if (!t.x) return;
      var data = inst && inst.tables[t.n];
      put(r, 1, t.n, 'marker');
      if (t.t) put(r, 2, t.t, 'subtitle');
      r += 1;
      var cell = function (row, col, code, rec) {
        var def = t.c[code];
        if (!def) put(row, col, undefined, 'blocked');
        else if (def[0] !== 0) put(row, col, undefined, 'calc');
        else put(row, col, bookValue(typeOf(spec, def), rec), inputStyle(typeOf(spec, def)));
      };
      if (t.k === 'S') {
        var cols = t.cols.map(function (c) { return c[0]; });
        headerRows(r, cols.map(function (c) { return t.colLabel[c] || c; }), cols, 5);
        r += 2;
        t.rows.forEach(function (row) {
          put(r, 2, row[1], 'label'); put(r, 3, row[2], 'label'); put(r, 4, row[0], 'code');
          cols.forEach(function (c, i) { cell(r, 5 + i, row[0] + c, data && data.cells[row[0] + c]); });
          r++;
        });
      } else if (t.k === 'Y') {
        var ycols = t.cols.map(function (c) { return c[0]; });
        headerRows(r, ycols.map(function (c) { return t.colLabel[c] || c; }), ycols, 5);
        r += 2;
        var items = (data && data.items) || [];
        items.concat(new Array(BLANK_LIST_ROWS).fill(null)).forEach(function (it) {
          put(r, 2, undefined, 'label'); put(r, 3, undefined, 'label'); put(r, 4, undefined, 'label');
          ycols.forEach(function (c, i) { cell(r, 5 + i, c, it ? it.cells[c] : undefined); });
          r++;
        });
      } else {
        // a list that runs across: one column per entry (or one group of columns
        // when every entry has several measures), the row codes down the side
        var codes = Object.keys(t.c);
        var measures = [];
        codes.forEach(function (c) { var m = /^R\d{4}(C\d{4})$/.exec(c); if (m && measures.indexOf(m[1]) < 0) measures.push(m[1]); });
        var rowCodes = [];
        codes.forEach(function (c) { var k = measures.length && /^R\d{4}C\d{4}$/.test(c) ? c.slice(0, 5) : c; if (rowCodes.indexOf(k) < 0) rowCodes.push(k); });
        var xitems = ((data && data.items) || []).concat([null, null, null]);
        var width = Math.max(1, measures.length);
        var labels = [], hcodes = [];
        xitems.forEach(function (it, i) {
          for (var m = 0; m < width; m++) {
            labels.push('Entry ' + (i + 1) + (measures.length ? ' / ' + (t.colLabel[measures[m]] || measures[m]) : ''));
            hcodes.push(measures.length ? measures[m] : '');
          }
        });
        headerRows(r, labels, hcodes, 5);
        if (!measures.length) delete rows[r + 1];          // no column codes for a single-measure list
        r += measures.length ? 2 : 1;
        rowCodes.forEach(function (rc) {
          var label = t.rowLabel[rc];
          put(r, 2, label ? label[1] : '', 'label'); put(r, 3, label ? label[2] : '', 'label'); put(r, 4, rc, 'code');
          xitems.forEach(function (it, i) {
            for (var m = 0; m < width; m++) {
              var col = 5 + i * width + m, code = measures.length && t.c[rc + measures[m]] ? rc + measures[m] : rc;
              if (code === rc && m > 0) { put(r, col, undefined, 'blocked'); continue; }
              cell(r, col, code, it ? it.cells[code] : undefined);
            }
          });
          r++;
        });
      }
      r += 2;
    });
    var widths = [14, 50, 20, 9];
    for (var c = 5; c <= maxCol; c++) widths.push(18);
    return { name: form.n, rows: rows, cols: widths };
  }

  // Schedules in the file with no value at all, such as <BRIS_LDR/>. An empty
  // sheet is read as a schedule not submitted, so the Header sheet lists these.
  function filedEmpty(spec, doc) {
    return spec.forms.filter(function (form) {
      var list = doc.forms[form.n];
      if (!form.x || !list) return false;
      return list.every(function (inst) {
        if (Object.keys(inst.fields).length) return false;
        return Object.keys(inst.tables).every(function (tn) {
          var t = inst.tables[tn];
          return t.items ? t.items.every(function (it) { return !Object.keys(it.cells).length; }) : !Object.keys(t.cells).length;
        });
      });
    }).map(function (form) { return form.n; });
  }

  function headerSheet(spec, doc) {
    var rows = {};
    function put(r, c, v, s) { (rows[r] = rows[r] || {})[c] = { v: v, s: s }; }
    put(1, 1, 'Header', 'title');
    put(2, 1, spec.report + ' version ' + spec.version + (spec.title ? ' - ' + spec.title : '') +
      '. Bank code and reporting period of this file; the validator reads them back from here.', 'subtitle');
    var r = 4;
    spec.header.forEach(function (hd) {
      var rec = doc.header[hd[0]], type = spec.types[hd[1]];
      put(r, 1, hd[0], 'marker');
      put(r, 2, rec && !rec.bad ? (type.b === 'i' ? rec.v : String(rec.raw).trim()) : (rec ? String(rec.raw) : undefined), type.b === 'i' ? 'count' : 'text');
      r++;
    });
    put(r + 1, 1, 'Filed empty', 'marker');
    put(r + 1, 2, filedEmpty(spec, doc).join(' ') || undefined, 'text');
    put(r + 2, 2, 'Schedules to send with no data (as <NAME/> in the XML), separated by spaces. Any other sheet left empty is not sent.', 'subtitle');
    return { name: 'Header', rows: rows, cols: [16, 60] };
  }

  function toXlsx(spec, doc, opts) {
    opts = opts || {};
    var notes = [];
    if (doc.fatal) return Promise.resolve({ bytes: null, notes: ['The file could not be read, so there is nothing to write.'] });
    var sheets = [headerSheet(spec, doc)];
    // values the file holds where the template has no input cell
    var dropped = doc.findings.filter(function (f) { return /^(XSD-CALCULATED|XSD-UNKNOWN|TPL-NOT-INPUT)$/.test(f.code) && f.cell; })
      .map(function (f) { return f.form + ' / ' + (f.table ? f.table + ' / ' : '') + f.cell; });
    if (dropped.length) notes.push('Left out, as the template has no input cell for them (totals the BSP works out, or cells the schema does not know): ' + dropped.join(', ') + '.');
    spec.forms.forEach(function (form) {
      if (!form.x) return;
      var list = doc.forms[form.n];
      if (list && list.length > 1) notes.push(form.n + ' has ' + list.length + ' book codes; the workbook holds only the first.');
      sheets.push(formSheet(spec, form, list && list[0], notes));
    });
    return XLSXW.write(sheets).then(function (bytes) { return { bytes: bytes, notes: notes, name: fileName(spec, doc, 'xlsx', opts.now) }; });
  }

  return { toXml: toXml, toXlsx: toXlsx, fileName: fileName };
});
