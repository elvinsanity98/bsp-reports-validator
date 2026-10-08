// Unpacks the compiled report definitions (src/spec-<report>.js) and indexes them.
//
//   BSPV.spec.list()                  -> [{ report, version, title, root, ns, sheets, periodStyle }]
//   BSPV.spec.load('WRR_RCB')         -> Promise of the full definition
//   BSPV.spec.detectXmlText(text)     -> report code of an XML file, by its root element
//   BSPV.spec.detectSheets([names])   -> report code of an Excel template, by its sheet names
//
// spec.forms[]        { n: name, t: title, x: 1 when the schedule is part of the XML, r: 1 when the schema requires it,
//                       z: { item, f, ty, t } for schedules repeated per book code,
//                       f: [[field, typeId, title]], tb: tables }
// table               { n, k: 'S' fixed grid | 'Y' list of rows | 'X' list of columns,
//                       t: title, x: 1 when part of the XML, r: 1 when required, item: element name of one entry,
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

  var NODE = typeof process !== 'undefined' && process.versions && process.versions.node && typeof require === 'function';

  function registry() {
    var B = root.BSPV = root.BSPV || {};
    if (!B.specs && NODE) {
      // In Node the generated files are not loaded by script tags; pick them up from this folder.
      var fs = require('fs'), path = require('path');
      fs.readdirSync(__dirname).filter(function (n) { return /^spec-.+\.js$/.test(n); }).sort()
        .forEach(function (n) { require(path.join(__dirname, n)); });
    }
    return B.specs || {};
  }

  function list() {
    var specs = registry();
    return Object.keys(specs).sort().map(function (k) {
      var s = specs[k];
      return { report: s.report, version: s.version, title: s.title, root: s.root, ns: s.ns, sheets: s.sheets, periodStyle: s.periodStyle || '' };
    });
  }

  function detectXml(rootName, ns) {
    var all = list(), i;
    for (i = 0; i < all.length; i++) if (all[i].ns === ns && all[i].root === rootName) return all[i].report;
    for (i = 0; i < all.length; i++) if (all[i].root === rootName) return all[i].report;
    return null;
  }

  // The report of an XML file, from its text. Looks at the first tag only, so
  // it also works on a file that is not well-formed.
  function detectXmlText(text) {
    var body = text.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![^>]*>/g, '');
    var m = /<(?:[\w.-]+:)?([A-Za-z_][\w.-]*)(\s[^>]*)?>/.exec(body);
    if (!m) return null;
    var ns = /\sxmlns(?::[\w.-]+)?\s*=\s*["']([^"']*)["']/.exec(m[2] || '');
    return detectXml(m[1], ns ? ns[1] : '');
  }

  function detectSheets(names) {
    var best = null, bestCount = 0;
    list().forEach(function (s) {
      var count = names.filter(function (n) { return s.sheets.indexOf(String(n).trim()) >= 0; }).length;
      if (count > bestCount) { best = s.report; bestCount = count; }
    });
    return best;
  }

  function index(spec) {
    spec.formByName = {};
    var formulas = [];
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
        Object.keys(t.c).forEach(function (code) { if (t.c[code][0] === 1) formulas.push(t.c[code][1]); });
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

    // What the rules ask for besides the file itself: facts about the bank, a
    // branch list, earlier periods. The page only asks for what is used.
    var bank = {}, branches = false, history = false;
    function scan(text) {
      if (!text) return;
      var re = /LOOKUP\(\s*"(\w+)"\s*;\s*"(\w+)"/g, m;
      while ((m = re.exec(text))) {
        if (m[1] === 'BANK') bank[m[2]] = true;
        else if (m[1] === 'BRANCH') branches = true;
      }
      if (text.indexOf('DWHS(') >= 0) history = true;
    }
    spec.rules.forEach(function (r) { scan(r[2]); scan(r[4]); scan(r[7] || ''); });
    spec.conds.forEach(scan);
    formulas.forEach(scan);
    spec.needs = { bank: bank, branches: branches, history: history };
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

  var cache = {};

  function load(report) {
    var specs = registry();
    if (!report) {
      var names = Object.keys(specs);
      if (names.length !== 1) return Promise.reject(new Error('Say which report to load: ' + names.sort().join(', ') + '.'));
      report = names[0];
    }
    if (cache[report]) return cache[report];
    var entry = specs[report];
    if (!entry) return Promise.reject(new Error('This tool has no definition for the report "' + report + '".'));
    if (NODE) {
      var text = require('zlib').gunzipSync(Buffer.from(entry.blob, 'base64')).toString('utf8');
      cache[report] = Promise.resolve(index(JSON.parse(text)));
      return cache[report];
    }
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('This browser is too old to open the report definition. Use a current Chrome, Edge or Firefox.'));
    }
    var bin = atob(entry.blob), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    cache[report] = new Response(stream).text().then(function (t) { return index(JSON.parse(t)); });
    return cache[report];
  }

  return { list: list, load: load, detectXml: detectXml, detectXmlText: detectXmlText, detectSheets: detectSheets, index: index, cellLabel: cellLabel };
});
