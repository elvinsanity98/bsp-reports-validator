// Unpacks the compiled report definition (src/spec-data.js) and indexes it.
//
//   BSPV.spec.load().then(function (spec) { ... })
//
// spec.forms[]        { n: name, t: title, x: 1 when the schedule is part of the XML,
//                       z: { item, f, ty, t } for schedules repeated per book code,
//                       f: [[field, typeId, title]], tb: tables }
// table               { n, k: 'S' fixed grid | 'Y' list of rows | 'X' list of columns,
//                       t: title, x: 1 when part of the XML, item: element name of one entry,
//                       c: { code: [kind, value, condition] }, rows: [[code, label, account]], cols: [[code, label]] }
// cell kind           0 reported (value = type id, or [type id] when required)
//                     1 calculated by the BSP (value = formula)   2 fixed number
// spec.rules[]        [code, message, left, operator, right, tolerance, loop, precondition, isWarning]
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.BSPV = root.BSPV || {}).spec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function index(spec) {
    spec.formByName = {};
    spec.forms.forEach(function (f) {
      spec.formByName[f.n] = f;
      f.tableByName = {};
      f.tb.forEach(function (t) {
        f.tableByName[t.n] = t;
        t.form = f;
        t.rowLabel = {};
        t.colLabel = {};
        (t.rows || []).forEach(function (r) { t.rowLabel[r[0]] = r; });
        (t.cols || []).forEach(function (c) { t.colLabel[c[0]] = c[1]; });
      });
      f.fieldByName = {};
      (f.f || []).forEach(function (x) { f.fieldByName[x[0]] = x; });
    });
    spec.types.forEach(function (t) {
      if (t.pat) t.re = new RegExp('^(?:' + t.pat + ')$');
      if (t.enum) {
        t.enumLabel = {};
        t.enum.forEach(function (e) { t.enumLabel[e[0]] = e[1]; });
      }
    });
    return spec;
  }

  // Human label of a cell: row and column captions from the specification.
  function cellLabel(table, code) {
    if (table.k === 'S') {
      var row = table.rowLabel[code.slice(0, 5)], col = table.colLabel[code.slice(5)];
      return [row && row[1], col].filter(Boolean).join(' | ');
    }
    if (table.k === 'Y') return table.colLabel[code] || '';
    var r = table.rowLabel[code] || table.rowLabel[code.slice(0, 5)];
    return r ? r[1] : '';
  }

  var cached = null;

  function load() {
    if (cached) return cached;
    var blob = (root.BSPV && root.BSPV.specBlob) || (typeof require === 'function' ? (require('./spec-data.js'), root.BSPV.specBlob) : null);
    if (!blob) return Promise.reject(new Error('The report definition (spec-data.js) is missing.'));
    if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof require === 'function') {
      var text = require('zlib').gunzipSync(Buffer.from(blob, 'base64')).toString('utf8');
      cached = Promise.resolve(index(JSON.parse(text)));
      return cached;
    }
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('This browser is too old to open the report definition. Use a current Chrome, Edge or Firefox.'));
    }
    var bin = atob(blob), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    cached = new Response(stream).text().then(function (text) { return index(JSON.parse(text)); });
    return cached;
  }

  return { load: load, index: index, cellLabel: cellLabel };
});
