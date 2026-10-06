// Validation engine. Works on a "document": the reported values of one
// submission, read from the XML file (readXml below) or from the Excel input
// template (src/template.js).
//
//   var doc = BSPV.engine.readXml(text, spec);
//   var result = BSPV.engine.check(spec, doc, { profile: {...}, history: { '2026-03': earlierDoc } });
//
// Three layers of checks:
//   1. the file is well-formed XML and follows the XSD (structure, value formats)
//   2. cells the specification marks as not applicable to this report are empty
//   3. every rule of the specification's "Assertions" sheet, after working out
//      the totals the BSP calculates itself
//
// A rule that needs something this tool does not have (the bank's reference
// data at the BSP, or an earlier period's submission) is counted as "not
// checked" with the reason; it never produces a finding.
(function (root, factory) {
  var api;
  if (typeof module !== 'undefined' && module.exports) {
    api = module.exports = factory(require('./xml.js'), require('./formula.js'), require('./spec.js'));
  } else {
    api = factory(root.BSPV.xml, root.BSPV.formula, root.BSPV.spec);
  }
  (root.BSPV = root.BSPV || {}).engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (XML, FORMULA, SPEC) {
  'use strict';

  // ---- values ----------------------------------------------------------------

  function unk(why) { return { unknown: true, why: why }; }
  function isUnk(v) { return v !== null && typeof v === 'object' && v.unknown === true; }
  function isNode(v) { return v !== null && typeof v === 'object' && v.kind !== undefined; }
  function scalar(v) { return isNode(v) ? null : v; }

  function numeric(v) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return true;
    return typeof v === 'string' && (v.trim() === '' || isFinite(Number(v)));
  }
  function num(v) {
    if (v === null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v.trim() === '' ? 0 : Number(v);
  }
  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (v === null) return false;
    if (typeof v === 'number') return v !== 0;
    return v.toUpperCase() === 'TRUE' || (isFinite(Number(v)) && Number(v) !== 0 && v.trim() !== '');
  }

  // Amounts are sums of two-decimal figures held in binary floating point, so
  // "equal" allows for the rounding noise of the additions and nothing more.
  function slack(a, b) { return Math.max(5e-7, 1e-13 * Math.max(Math.abs(a), Math.abs(b))); }

  function compareNumbers(a, op, b, tol) {
    var d = a - b, e = slack(a, b);
    switch (op) {
      case '=': return Math.abs(d) <= tol + e;
      case '<>': return Math.abs(d) > tol + e;
      case '>=': return d >= -(tol + e);
      case '<=': return d <= tol + e;
      case '>': return d > e - tol;
      case '<': return d < tol - e;
    }
    throw new Error('Unknown operator ' + op);
  }

  function compare(a, op, b, tol) {
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (op === '=') return truthy(a) === truthy(b);
      if (op === '<>') return truthy(a) !== truthy(b);
    }
    var bothText = typeof a === 'string' && typeof b === 'string';
    if (!bothText && numeric(a) && numeric(b)) return compareNumbers(num(a), op, num(b), tol);
    var x = a === null ? '' : String(a), y = b === null ? '' : String(b);
    if (bothText && numeric(a) && numeric(b) && op !== '=' && op !== '<>') return compareNumbers(num(a), op, num(b), tol);
    switch (op) {
      case '=': return x === y;
      case '<>': return x !== y;
      case '>=': return x >= y;
      case '<=': return x <= y;
      case '>': return x > y;
      case '<': return x < y;
    }
    throw new Error('Unknown operator ' + op);
  }

  // ---- value formats (XSD simple types) --------------------------------------

  var TYPE_WORDS = {
    amount: 'an amount (digits, up to 2 decimals, minus sign allowed)',
    amount_pos: 'an amount of zero or more (digits, up to 2 decimals)',
    number_of9: 'a whole number from 0 to 999,999,999',
    number_of6: 'a whole number from 0 to 999,999',
    number_of15: 'a whole number of up to 15 digits',
    whole_number_9: 'a whole number of up to 9 digits',
    percent: 'a rate of zero or more (up to 6 decimals)',
    par_value: 'a number with up to 4 decimals'
  };

  function typeWords(type) {
    var key = type.n.replace(/^Ptype_/, '');
    if (TYPE_WORDS[key]) return TYPE_WORDS[key];
    if (type.enum) return 'one of the codes ' + type.enum.map(function (e) { return e[0]; }).join(', ');
    if (type.b === 'D') return 'a date written YYYY-MM-DD';
    if (type.b === 'i') return 'a whole number from ' + type.min + ' to ' + type.max;
    if (type.b === 'd') return 'a number';
    if (type.maxLen) return 'text of ' + (type.minLen > 0 ? type.minLen + ' to ' : 'up to ') + type.maxLen + ' characters';
    return 'text';
  }

  // Returns { v } with the typed value, or { err } saying what is wrong.
  function checkValue(type, raw) {
    if (type.b === 'd' || type.b === 'i') {
      var s = raw.trim();
      if (s === '') return { err: 'is empty. Leave the cell out of the file instead of sending it blank' };
      if (/,/.test(s)) return { err: 'has a comma. Write the number without thousands separators' };
      if (/^\(.*\)$/.test(s)) return { err: 'uses brackets for a negative. Write a minus sign instead' };
      if (/[eE]/.test(s) && /^[-+]?[0-9.]+[eE][-+]?\d+$/.test(s)) return { err: 'is in scientific notation. Write the number out in full' };
      if (!(type.b === 'i' ? /^[-+]?\d+$/ : /^[-+]?(\d+(\.\d*)?|\.\d+)$/).test(s)) {
        if (type.b === 'i' && /^[-+]?\d+\.\d+$/.test(s)) return { err: 'has decimals; it must be ' + typeWords(type) };
        return { err: 'is not a number; it must be ' + typeWords(type) };
      }
      var v = Number(s);
      var frac = (s.split('.')[1] || '').replace(/0+$/, '');
      if (type.fd !== undefined && (s.split('.')[1] || '').length > Number(type.fd)) {
        return { err: 'has more than ' + type.fd + ' decimal places' };
      }
      if (type.min !== undefined && v < Number(type.min)) {
        return { err: Number(type.min) === 0 ? 'is negative; it must be ' + typeWords(type) : 'is below the minimum of ' + type.min };
      }
      if (type.max !== undefined && v > Number(type.max)) return { err: 'is above the maximum of ' + type.max };
      var digits = s.replace(/^[-+]/, '').split('.')[0].replace(/^0+(?=\d)/, '').length + frac.length;
      if (type.td !== undefined && digits > Number(type.td)) return { err: 'has more than ' + type.td + ' digits' };
      if (type.re && !type.re.test(s)) {
        if (s.charAt(0) === '+') return { err: 'starts with a plus sign, which the schema does not accept' };
        return { err: 'is not written the way the schema expects; it must be ' + typeWords(type) };
      }
      return { v: v };
    }
    if (type.b === 'D') {
      var d = raw.trim();
      var m = /^(\d{4})-(\d{2})-(\d{2})(Z|[-+]\d{2}:\d{2})?$/.exec(d);
      if (!m) return { err: 'is not a date written YYYY-MM-DD' };
      var y = +m[1], mo = +m[2], day = +m[3];
      var dt = new Date(Date.UTC(y, mo - 1, day));
      if (mo < 1 || mo > 12 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== day) return { err: 'is not a real calendar date' };
      return { v: d.slice(0, 10) };
    }
    var len = Array.from(raw).length;
    if (type.enum) {
      if (!Object.prototype.hasOwnProperty.call(type.enumLabel, raw)) {
        var hint = type.enum.length <= 8
          ? type.enum.map(function (e) { return e[0] + ' = ' + e[1]; }).join(', ')
          : type.enum[0][0] + ' to ' + type.enum[type.enum.length - 1][0];
        return { err: 'is not an allowed code (' + hint + ')' };
      }
      return { v: raw };
    }
    if (type.minLen !== undefined && len < Number(type.minLen)) return { err: len === 0 ? 'is empty; it is required text' : 'is shorter than ' + type.minLen + ' characters' };
    if (type.maxLen !== undefined && len > Number(type.maxLen)) return { err: 'is ' + len + ' characters long; the limit is ' + type.maxLen };
    if (type.re && !type.re.test(raw)) return { err: /^\s/.test(raw) ? 'starts with a space' : 'is not written the way the schema expects' };
    return { v: raw };
  }

  function cellType(spec, cell) {
    var t = cell[1];
    return spec.types[Array.isArray(t) ? t[0] : t];
  }
  function cellRequired(cell) { return Array.isArray(cell[1]); }

  // ---- reading the XML submission --------------------------------------------

  function readXml(text, spec) {
    var doc = { source: 'xml', header: {}, forms: {}, findings: [], lines: 0 };
    function add(sev, code, msg, at, extra) {
      var f = { sev: sev, code: code, kind: 'file', msg: msg, line: at ? at.line : undefined };
      if (extra) Object.keys(extra).forEach(function (k) { f[k] = extra[k]; });
      doc.findings.push(f);
    }

    var parsed;
    try {
      parsed = XML.parse(text);
    } catch (e) {
      if (!(e instanceof XML.XmlError)) throw e;
      add('error', 'XML-WELLFORMED', e.message + ' (line ' + e.line + ', column ' + e.col + '). Nothing else can be checked until this is fixed.', { line: e.line });
      doc.fatal = true;
      return doc;
    }
    doc.lines = parsed.lines;
    doc.encoding = parsed.decl && parsed.decl.encoding;
    var top = parsed.root;
    if (top.name !== spec.root) {
      add('error', 'XSD-ROOT', 'The file starts with <' + top.qname + '>; a ' + spec.report + ' submission must start with <' + spec.root + '>.', top);
      doc.fatal = true;
      return doc;
    }
    if (top.ns !== spec.ns) {
      add('error', 'XSD-NAMESPACE', top.ns
        ? 'The file declares the namespace "' + top.ns + '"; this report version needs xmlns="' + spec.ns + '".'
        : 'The root element has no namespace. Write it as <' + spec.root + ' xmlns="' + spec.ns + '">.', top);
    }
    var nsWarned = false;

    function attrsOk(el) {
      Object.keys(el.attrs).forEach(function (a) {
        if (a === 'xmlns' || a.slice(0, 6) === 'xmlns:' || a.slice(0, 4) === 'xsi:') return;
        add('error', 'XSD-ATTRIBUTE', 'Attribute ' + a + ' on <' + el.qname + '> is not part of the schema.', el);
      });
    }
    function strayText(el) {
      if (/\S/.test(el.text)) add('error', 'XSD-TEXT', '<' + el.qname + '> holds other elements, but there is loose text inside it: "' + el.text.trim().slice(0, 40) + '".', el);
    }
    function nsOk(el) {
      if (el.ns !== top.ns && !nsWarned) {
        nsWarned = true;
        add('error', 'XSD-NAMESPACE', '<' + el.qname + '> is in a different namespace from the root element. Every element must be in "' + spec.ns + '".', el);
      }
    }

    // One reported value. Returns the record kept in the document.
    function leaf(el, type, where) {
      attrsOk(el);
      nsOk(el);
      var rec = { raw: el.text, v: null, line: el.line };
      if (el.children.length) {
        add('error', 'XSD-TYPE', where.text + ' must hold a plain value, but it has elements inside it.', el, where.at);
        rec.bad = true;
        return rec;
      }
      var r = checkValue(type, el.text);
      if (r.err) {
        add('error', 'XSD-TYPE', where.text + ': "' + el.text.slice(0, 60) + '" ' + r.err + '.', el, where.at);
        rec.bad = true;
      } else {
        rec.v = r.v;
      }
      return rec;
    }

    function readCells(el, table, formName, itemNo) {
      var cells = {};
      strayText(el);
      attrsOk(el);
      el.children.forEach(function (c) {
        var def = table.c[c.name];
        var at = { form: formName, table: table.n, cell: c.name };
        if (itemNo !== undefined) at.item = itemNo;
        var label = formName + ' / ' + table.n + (itemNo !== undefined ? ' entry ' + (itemNo + 1) : '') + ' / ' + c.name;
        if (!def) {
          nsOk(c);
          add('error', 'XSD-UNKNOWN', label + ' is not a cell of this table in the schema.', c, at);
          return;
        }
        if (def[0] !== 0) {
          add('error', 'XSD-CALCULATED', label + ' is a total the BSP works out itself. The schema does not accept it in the file; remove it.', c, at);
          return;
        }
        if (cells[c.name]) {
          add('error', 'XSD-DUPLICATE', label + ' appears more than once.', c, at);
          return;
        }
        cells[c.name] = leaf(c, cellType(spec, def), { text: label, at: at });
      });
      if (itemNo !== undefined) {
        Object.keys(table.c).forEach(function (code) {
          var def = table.c[code];
          if (def[0] === 0 && cellRequired(def) && !cells[code]) {
            add('error', 'XSD-REQUIRED', formName + ' / ' + table.n + ' entry ' + (itemNo + 1) + ' has no ' + code +
              (SPEC.cellLabel(table, code) ? ' (' + SPEC.cellLabel(table, code) + ')' : '') + ', which every entry must have.', el,
              { form: formName, table: table.n, cell: code, item: itemNo });
          }
        });
      }
      return cells;
    }

    function readBody(el, form, inst) {
      strayText(el);
      attrsOk(el);
      el.children.forEach(function (c) {
        nsOk(c);
        var table = form.tableByName[c.name];
        if (table && table.x) {
          if (inst.tables[c.name]) {
            add('error', 'XSD-DUPLICATE', form.n + ' / ' + c.name + ' appears more than once.', c, { form: form.n, table: c.name });
            return;
          }
          if (table.k === 'S') {
            inst.tables[c.name] = { line: c.line, cells: readCells(c, table, form.n) };
          } else {
            var items = [];
            strayText(c);
            attrsOk(c);
            c.children.forEach(function (it) {
              nsOk(it);
              if (it.name !== table.item) {
                add('error', 'XSD-UNKNOWN', form.n + ' / ' + c.name + ' may only hold <' + table.item + '> entries; found <' + it.qname + '>.', it, { form: form.n, table: c.name });
                return;
              }
              items.push({ line: it.line, index: items.length, cells: readCells(it, table, form.n, items.length) });
            });
            inst.tables[c.name] = { line: c.line, items: items };
          }
          return;
        }
        var field = form.fieldByName[c.name] || (form.z && form.z.f === c.name ? [form.z.f, form.z.ty, form.z.t] : null);
        if (field) {
          if (inst.fields[c.name]) {
            add('error', 'XSD-DUPLICATE', form.n + ' / ' + c.name + ' appears more than once.', c, { form: form.n });
            return;
          }
          inst.fields[c.name] = leaf(c, spec.types[field[1]], { text: form.n + ' / ' + c.name, at: { form: form.n, cell: c.name } });
          return;
        }
        add('error', table ? 'XSD-CALCULATED' : 'XSD-UNKNOWN', table
          ? form.n + ' / ' + c.name + ' is a table the BSP fills in itself. The schema does not accept it in the file; remove it.'
          : form.n + ' has no table or field called ' + c.name + ' in the schema.', c, { form: form.n });
      });
    }

    strayText(top);
    attrsOk(top);
    var seen = {};
    top.children.forEach(function (el) {
      nsOk(el);
      if (seen[el.name]) {
        add('error', 'XSD-DUPLICATE', '<' + el.name + '> appears more than once (first on line ' + seen[el.name] + '). Each schedule may appear only once.', el, { form: el.name });
        return;
      }
      if (el.name === 'Header') {
        seen.Header = el.line;
        strayText(el);
        attrsOk(el);
        el.children.forEach(function (c) {
          var def = spec.header.filter(function (h) { return h[0] === c.name; })[0];
          if (!def) {
            add('error', 'XSD-UNKNOWN', 'Header has no field called ' + c.name + ' in the schema.', c);
          } else if (doc.header[c.name]) {
            add('error', 'XSD-DUPLICATE', 'Header / ' + c.name + ' appears more than once.', c);
          } else {
            doc.header[c.name] = leaf(c, spec.types[def[1]], { text: 'Header / ' + c.name, at: { form: 'Header', cell: c.name } });
          }
        });
        spec.header.forEach(function (h) {
          if (!doc.header[h[0]]) add('error', 'XSD-HEADER', 'Header is missing <' + h[0] + '>.', el, { form: 'Header', cell: h[0] });
        });
        return;
      }
      var form = spec.formByName[el.name];
      if (!form) {
        add('error', 'XSD-UNKNOWN', '<' + el.qname + '> is not a schedule of ' + spec.report + ' version ' + spec.version + '.', el);
        return;
      }
      if (!form.x) {
        add('error', 'XSD-CALCULATED', 'Schedule ' + form.n + ' is put together by the BSP from other schedules. The schema does not accept it in the file; remove it.', el, { form: form.n });
        return;
      }
      seen[el.name] = el.line;
      if (form.z) {
        var list = [];
        strayText(el);
        attrsOk(el);
        el.children.forEach(function (it) {
          nsOk(it);
          if (it.name !== form.z.item) {
            add('error', 'XSD-UNKNOWN', form.n + ' may only hold <' + form.z.item + '> entries; found <' + it.qname + '>.', it, { form: form.n });
            return;
          }
          var inst = { name: form.n, line: it.line, fields: {}, tables: {} };
          readBody(it, form, inst);
          if (!inst.fields[form.z.f]) {
            add('error', 'XSD-REQUIRED', form.n + ' entry ' + (list.length + 1) + ' has no <' + form.z.f + '>.', it, { form: form.n, cell: form.z.f });
          }
          list.push(inst);
        });
        var keys = {};
        list.forEach(function (inst) {
          var k = inst.fields[form.z.f];
          if (!k || k.bad) return;
          if (keys[k.v]) add('error', 'XSD-UNIQUE', form.n + ' has two entries with ' + form.z.f + ' ' + k.v + ' (first on line ' + keys[k.v] + ').', k, { form: form.n, cell: form.z.f });
          else keys[k.v] = inst.line;
        });
        doc.forms[form.n] = list;
        doc.formLine = doc.formLine || {};
        doc.formLine[form.n] = el.line;
      } else {
        var one = { name: form.n, line: el.line, fields: {}, tables: {} };
        readBody(el, form, one);
        doc.forms[form.n] = [one];
      }
    });
    if (!seen.Header) add('error', 'XSD-HEADER', 'The file has no <Header> (Undertaking, Year, Period). It is required.', top, { form: 'Header' });
    return doc;
  }

  // Turns the bytes of a file into text, honouring a byte-order mark or the
  // encoding named in the <?xml ...?> line. Returns { text, encoding, damaged }.
  function decode(bytes) {
    var encoding = 'utf-8';
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = 'utf-16le';
    else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be';
    else if (!(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)) {
      var head = '';
      for (var i = 0; i < Math.min(bytes.length, 200); i++) head += String.fromCharCode(bytes[i]);
      var m = /^<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
      if (m) encoding = m[1].toLowerCase();
    }
    var text;
    try {
      text = new TextDecoder(encoding).decode(bytes);
    } catch (e) {
      encoding = 'utf-8';
      text = new TextDecoder('utf-8').decode(bytes);
    }
    return { text: text, encoding: encoding, damaged: text.indexOf(String.fromCharCode(0xFFFD)) >= 0 };
  }

  function readXmlBytes(bytes, spec) {
    var d = decode(bytes);
    var doc = readXml(d.text, spec);
    if (d.damaged) {
      doc.findings.unshift({
        sev: 'error', code: 'XML-ENCODING', kind: 'file',
        msg: 'Some bytes in the file are not valid ' + d.encoding.toUpperCase() + ' text. Save the file as UTF-8.'
      });
    }
    return doc;
  }

  // ---- evaluator -------------------------------------------------------------

  function Evaluator(spec, doc, opts) {
    opts = opts || {};
    this.spec = spec;
    this.doc = doc;
    this.profile = opts.profile || {};
    this.history = opts.history || {};
    this.inst = {};
    this.busy = 0;
    this.global = { form: null, table: null, item: null, vars: {} };
  }

  function ast(holder, key, text) {
    var k = '_' + key;
    if (holder[k] === undefined) holder[k] = FORMULA.parse(String(text));
    return holder[k];
  }

  Evaluator.prototype.formSources = function (form) {
    if (form.sources) return form.sources;
    var set = {}, spec = this.spec;
    form.tb.forEach(function (t) {
      Object.keys(t.c).forEach(function (code) {
        var c = t.c[code];
        if (c[0] !== 1) return;
        FORMULA.walk(ast(c, 'ast', c[1]), function (n) {
          if (n.t === 'ref' && n.scope === null && spec.formByName[n.path[0]] && n.path[0] !== form.n) set[n.path[0]] = true;
        });
      });
    });
    form.sources = Object.keys(set);
    return form.sources;
  };

  // The instances of a schedule: one normally, one per book code for a
  // schedule with a Z axis, none when it was not submitted.
  Evaluator.prototype.instances = function (name) {
    if (this.inst[name]) return this.inst[name];
    var form = this.spec.formByName[name], self = this, list;
    if (form.x) {
      list = (this.doc.forms[name] || []).map(function (data) { return { kind: 'form', spec: form, data: data, tables: {} }; });
    } else {
      // Derived schedule: it exists once any schedule it is built from exists.
      this.inst[name] = [];
      var present = this.formSources(form).some(function (s) { return self.instances(s).length > 0; });
      list = present ? [{ kind: 'form', spec: form, data: null, tables: {} }] : [];
    }
    this.inst[name] = list;
    return list;
  };

  Evaluator.prototype.present = function (name) { return this.instances(name).length > 0; };

  Evaluator.prototype.absent = function (name) {
    var key = '!' + name;
    if (!this.inst[key]) this.inst[key] = { kind: 'form', spec: this.spec.formByName[name], data: null, tables: {}, absent: true };
    return this.inst[key];
  };

  Evaluator.prototype.table = function (fctx, name) {
    if (fctx.tables[name]) return fctx.tables[name];
    var t = fctx.spec.tableByName[name];
    if (!t) return null;
    var data = (fctx.data && fctx.data.tables[name]) || null;
    var ctx = { kind: 'table', form: fctx, spec: t, data: data, memo: {} };
    if (t.k !== 'S') {
      ctx.items = ((data && data.items) || []).map(function (d, i) {
        return { kind: 'item', table: ctx, data: d, index: i, memo: {} };
      });
    }
    fctx.tables[name] = ctx;
    return ctx;
  };

  Evaluator.prototype.cell = function (base, code) {
    var def = base.kind === 'table' ? base.spec.c[code] : base.table.spec.c[code];
    if (!def) return null;
    if (def[0] === 2) return def[1];
    if (def[0] === 0) {
      var cells = base.kind === 'table' ? (base.data && base.data.cells) : base.data.cells;
      var d = cells && cells[code];
      if (!d) return null;
      return d.bad ? unk('a value that is not in the right format') : d.v;
    }
    if (code in base.memo) {
      var m = base.memo[code];
      return m === base ? unk('a formula that refers to itself') : m;
    }
    base.memo[code] = base;
    var ctx = base.kind === 'table'
      ? { form: base.form, table: base, item: null, vars: {} }
      : { form: base.table.form, table: base.table, item: base, vars: {} };
    var v;
    if (this.busy > 400) {
      v = unk('a formula chain that is too deep');
    } else {
      this.busy++;
      try { v = scalar(this.eval(ast(def, 'ast', def[1]), ctx)); } finally { this.busy--; }
    }
    base.memo[code] = v;
    return v;
  };

  Evaluator.prototype.step = function (base, seg) {
    if (!isNode(base)) return null;
    if (base.kind === 'form') {
      var t = this.table(base, seg);
      if (t) return t;
      var f = base.data && base.data.fields[seg];
      if (!f) return null;
      return f.bad ? unk('a value that is not in the right format') : f.v;
    }
    if (base.kind === 'table') return base.spec.k === 'S' ? this.cell(base, seg) : null;
    if (base.kind === 'item') return this.cell(base, seg);
    return null;
  };

  // Resolves all but the last name of a reference. Returns { base, last }.
  Evaluator.prototype.locate = function (node, ctx) {
    var path = node.path, base, k = 0;
    if (node.scope === null) {
      var first = path[0];
      if (first === 'Header') return { header: path[1] };
      var form = this.spec.formByName[first];
      if (form) {
        var list = this.instances(first);
        if (path.length === 1) return { formref: first, list: list };
        if (list.length > 1) return { ambiguous: first };
        base = list[0] || this.absent(first);
        k = 1;
      } else {
        base = ctx.form;
      }
    } else if (node.scope === '$') {
      base = ctx.item || ctx.table || ctx.form;
    } else if (node.scope === '$0') {
      base = ctx.form;
    } else {
      base = ctx.vars[node.scope];
    }
    if (!base) return { base: null, last: path[path.length - 1] };
    for (; k < path.length - 1; k++) base = this.step(base, path[k]);
    return { base: base, last: path[path.length - 1] };
  };

  Evaluator.prototype.ref = function (node, ctx) {
    var at = this.locate(node, ctx);
    if (at.header !== undefined) {
      var h = this.doc.header[at.header];
      if (!h) return null;
      return h.bad ? unk('a header value that is not in the right format') : h.v;
    }
    if (at.formref) return { kind: 'formref', name: at.formref, list: at.list };
    if (at.ambiguous) return unk('schedule ' + at.ambiguous + ' has several book codes');
    if (isUnk(at.base)) return at.base;
    return this.step(at.base, at.last);
  };

  Evaluator.prototype.rows = function (node, ctx) {
    var v = this.ref(node, ctx);
    if (isUnk(v)) return v;
    if (isNode(v)) {
      if (v.kind === 'formref') return v.list;
      if (v.kind === 'table' && v.items) return v.items;
    }
    return [];
  };

  // The month a DWHS("Q-1"; ...) style reference points at, as 'YYYY-MM'.
  Evaluator.prototype.periodKey = function (code) {
    var y = this.doc.header.Year && this.doc.header.Year.v, p = this.doc.header.Period && this.doc.header.Period.v;
    var m = /^(M|Q|Y|YE)-(\d+)$/.exec(String(code));
    if (typeof y !== 'number' || typeof p !== 'number' || !m) return null;
    var n = +m[2], months = y * 12 + (p - 1);
    if (m[1] === 'M') months -= n;
    else if (m[1] === 'Q') months -= 3 * n;
    else if (m[1] === 'Y') months -= 12 * n;
    else months = (y - n) * 12 + 11;
    return Math.floor(months / 12) + '-' + ('0' + (months % 12 + 1)).slice(-2);
  };

  Evaluator.prototype.eval = function (n, ctx) {
    var self = this, a, b, i;
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'ref': return this.ref(n, ctx);
      case 'neg':
        a = scalar(this.eval(n.a, ctx));
        if (isUnk(a)) return a;
        return numeric(a) ? -num(a) : unk('text used as a number');
      case 'bin':
        if (n.op === 'AND' || n.op === 'OR') {
          a = scalar(this.eval(n.a, ctx));
          var stop = n.op === 'OR';
          if (!isUnk(a) && truthy(a) === stop) return stop;
          b = scalar(this.eval(n.b, ctx));
          if (!isUnk(b) && truthy(b) === stop) return stop;
          if (isUnk(a)) return a;
          if (isUnk(b)) return b;
          return !stop;
        }
        a = scalar(this.eval(n.a, ctx));
        if (isUnk(a)) return a;
        b = scalar(this.eval(n.b, ctx));
        if (isUnk(b)) return b;
        switch (n.op) {
          case '+': case '-': case '*': case '/':
            if (!numeric(a) || !numeric(b)) return unk('text used as a number');
            a = num(a); b = num(b);
            if (n.op === '+') return a + b;
            if (n.op === '-') return a - b;
            if (n.op === '*') return a * b;
            return b === 0 ? unk('a division by zero') : a / b;
          default:
            return compare(a, n.op, b, 0);
        }
      case 'iter':
        return this.ref(n.list, ctx);
      case 'call':
        switch (n.fn) {
          case 'ISNULL':
            a = this.eval(n.args[0], ctx);
            if (isUnk(a)) return a;
            if (isNode(a)) {
              if (a.kind === 'formref') return a.list.length === 0;
              if (a.kind === 'table') return a.form.absent === true || (a.spec.x === 1 && a.data === null);
              return false;
            }
            return a === null;
          case 'IF':
            a = scalar(this.eval(n.args[0], ctx));
            if (isUnk(a)) return a;
            return scalar(this.eval(truthy(a) ? n.args[1] : n.args[2], ctx));
          case 'SUM': case 'SUMIF': case 'COUNTIF': case 'COUNT':
            var it = n.args[0], list = this.rows(it.t === 'iter' ? it.list : it, ctx);
            if (isUnk(list)) return list;
            if (n.fn === 'COUNT') return list.length;
            var vars = Object.create(ctx.vars), inner = { form: ctx.form, table: ctx.table, item: ctx.item, vars: vars };
            var cond = n.fn === 'SUM' ? null : n.args[1], term = n.fn === 'SUM' ? n.args[1] : n.args[2];
            var total = 0;
            for (i = 0; i < list.length; i++) {
              if (it.t === 'iter') vars[it.v] = list[i];
              if (cond) {
                a = scalar(this.eval(cond, inner));
                if (isUnk(a)) return a;
                if (!truthy(a)) continue;
              }
              if (n.fn === 'COUNTIF') { total++; continue; }
              b = scalar(this.eval(term, inner));
              if (isUnk(b)) return b;
              if (!numeric(b)) return unk('text used as a number');
              total += num(b);
            }
            return total;
          case 'ISANYOF':
            a = scalar(this.eval(n.args[0], ctx));
            if (isUnk(a)) return a;
            for (i = 1; i < n.args.length; i++) {
              b = scalar(this.eval(n.args[i], ctx));
              if (isUnk(b)) return b;
              if (compare(a, '=', b, 0)) return true;
            }
            return false;
          case 'MAX': case 'MIN':
            var best = null;
            for (i = 0; i < n.args.length; i++) {
              a = scalar(this.eval(n.args[i], ctx));
              if (isUnk(a)) return a;
              if (!numeric(a)) return unk('text used as a number');
              a = num(a);
              if (best === null || (n.fn === 'MAX' ? a > best : a < best)) best = a;
            }
            return best;
          case 'ROW':
            return ctx.item ? ctx.item.index + 1 : null;
          case 'RCTX':
            a = scalar(this.eval(n.args[0], ctx));
            return a === 'RCODE' ? this.spec.report : unk('the submission context "' + a + '"');
          case 'LOOKUP':
            var set = scalar(this.eval(n.args[0], ctx)), field = scalar(this.eval(n.args[1], ctx));
            if (set === 'BANK') {
              var bank = this.profile.bank || {};
              return bank[field] === undefined || bank[field] === null || bank[field] === ''
                ? unk('bank profile: ' + field) : bank[field];
            }
            if (set === 'BRANCH') {
              if (!this.profile.branches) return unk('branch list');
              a = scalar(this.eval(n.args[3], ctx));
              if (isUnk(a)) return a;
              var br = this.profile.branches[String(a === null ? '' : a).trim()];
              if (!br) return null;
              return br[field] === undefined ? unk('branch list: ' + field) : br[field];
            }
            return unk('reference table ' + set);
          case 'DWHS':
            var code = scalar(this.eval(n.args[0], ctx)), key = this.periodKey(code);
            var past = key && this.history[key];
            if (!past) return unk('earlier period' + (key ? ' ' + key : ''));
            var target = n.args[1];
            if (target.t === 'ref' && target.scope === null && target.path.length === 1) return past.present(target.path[0]);
            return scalar(past.eval(target, past.global));
        }
        return unk('function ' + n.fn);
    }
    return unk('formula element ' + n.t);
  };

  // ---- describing a failed rule ----------------------------------------------

  function show(node) {
    switch (node.t) {
      case 'num': return String(node.v);
      case 'str': return '"' + node.v + '"';
      case 'bool': return node.v ? 'TRUE' : 'FALSE';
      case 'ref': return (node.scope || '') + node.path.map(function (p) { return '[' + p + ']'; }).join('');
      case 'iter': return show(node.list) + ':' + node.v;
      case 'neg': return '-' + show(node.a);
      case 'bin': return '(' + show(node.a) + ' ' + node.op + ' ' + show(node.b) + ')';
      case 'call': return node.fn + '(' + node.args.map(show).join('; ') + ')';
    }
    return '?';
  }

  // The cells a formula reads directly, with their values, for the detail view.
  Evaluator.prototype.operands = function (tree, ctx, limit) {
    var out = [], seen = {}, self = this;
    function visit(n) {
      if (out.length >= limit) return;
      if (n.t === 'bin') { visit(n.a); visit(n.b); return; }
      if (n.t === 'neg') { visit(n.a); return; }
      if (n.t === 'call' && (n.fn === 'IF' || n.fn === 'MAX' || n.fn === 'MIN' || n.fn === 'ISANYOF')) { n.args.forEach(visit); return; }
      if (n.t !== 'ref' && n.t !== 'call') return;
      var text = show(n);
      if (seen[text]) return;
      seen[text] = true;
      var o = { text: text };
      var v = n.t === 'ref' ? self.ref(n, ctx) : self.eval(n, ctx);
      if (isNode(v)) return;
      o.value = isUnk(v) ? undefined : v;
      if (isUnk(v)) o.unknown = v.why;
      if (n.t === 'ref') {
        var at = self.locate(n, ctx);
        if (at.header !== undefined) {
          o.form = 'Header';
          o.cell = at.header;
          var h = self.doc.header[at.header];
          if (h) { o.line = h.line; o.loc = h.loc; }
        } else if (isNode(at.base) && (at.base.kind === 'table' || at.base.kind === 'item')) {
          var t = at.base.kind === 'table' ? at.base : at.base.table;
          var def = t.spec.c[at.last];
          o.form = t.form.spec.n;
          o.table = t.spec.n;
          o.cell = at.last;
          o.label = SPEC.cellLabel(t.spec, at.last);
          if (at.base.kind === 'item') o.item = at.base.index;
          if (def && def[0] === 1) { o.calc = true; o.formula = def[1]; }
          var cells = at.base.kind === 'table' ? (at.base.data && at.base.data.cells) : at.base.data.cells;
          var d = cells && cells[at.last];
          if (d) { o.line = d.line; o.loc = d.loc; }
        }
      }
      out.push(o);
    }
    visit(tree);
    return out;
  };

  // The value of one cell as the BSP will see it: null when blank, or
  // { unknown, why } when it cannot be worked out here.
  Evaluator.prototype.valueOf = function (formName, tableName, code, itemIndex) {
    var fctx = this.instances(formName)[0] || this.absent(formName);
    var t = this.table(fctx, tableName);
    if (!t) return null;
    var base = itemIndex !== undefined && t.items ? t.items[itemIndex] : t;
    return base ? this.cell(base, code) : null;
  };

  Evaluator.prototype.itemCount = function (formName, tableName) {
    var fctx = this.instances(formName)[0] || this.absent(formName);
    var t = this.table(fctx, tableName);
    return t && t.items ? t.items.length : 0;
  };

  // Value, formula and inputs of one cell, for the schedule viewer.
  Evaluator.prototype.explain = function (formName, tableName, code, itemIndex) {
    var list = this.instances(formName);
    var fctx = list[0] || this.absent(formName);
    var t = this.table(fctx, tableName);
    if (!t) return null;
    var base = itemIndex !== undefined && t.items ? t.items[itemIndex] : t;
    if (!base) return null;
    var def = t.spec.c[code];
    var v = this.cell(base, code);
    var out = { value: isUnk(v) ? undefined : v, unknown: isUnk(v) ? v.why : undefined, label: SPEC.cellLabel(t.spec, code) };
    if (def && def[0] === 1) {
      out.formula = def[1];
      var ctx = base.kind === 'table' ? { form: fctx, table: t, item: null, vars: {} } : { form: fctx, table: t, item: base, vars: {} };
      out.inputs = this.operands(ast(def, 'ast', def[1]), ctx, 40);
    }
    return out;
  };

  // ---- running the checks ----------------------------------------------------

  function firstForm(spec, trees) {
    var found = null;
    trees.forEach(function (t) {
      if (found || !t) return;
      FORMULA.walk(t, function (n) {
        if (!found && n.t === 'ref' && n.scope === null && spec.formByName[n.path[0]]) found = n.path[0];
      });
    });
    return found;
  }

  function reasonGroup(why) {
    if (/^bank profile/.test(why)) return 'profile';
    if (/^branch list/.test(why)) return 'branches';
    if (/^earlier period/.test(why)) return 'history';
    if (/right format/.test(why)) return 'format';
    return 'other';
  }

  function check(spec, doc, opts) {
    opts = opts || {};
    var findings = doc.findings.slice();
    var stats = { rules: spec.rules.length, passed: 0, failed: 0, notApplicable: 0, skipped: {}, skippedTotal: 0, skippedWhy: {} };
    var result = { doc: doc, findings: findings, stats: stats, spec: spec };
    if (doc.fatal) return finish(result);

    var history = {};
    Object.keys(opts.history || {}).forEach(function (k) {
      history[k] = new Evaluator(spec, opts.history[k], { profile: opts.profile });
    });
    var ev = new Evaluator(spec, doc, { profile: opts.profile, history: history });
    result.evaluator = ev;

    // Cells the specification switches off for this report.
    var condTrue = spec.conds.map(function (c) { return FORMULA.parse(c); });
    Object.keys(doc.forms).forEach(function (name) {
      ev.instances(name).forEach(function (fctx) {
        Object.keys(fctx.data.tables).forEach(function (tn) {
          var t = ev.table(fctx, tn);
          var bases = t.items || [t];
          bases.forEach(function (base) {
            var cells = base.data.cells;
            Object.keys(cells).forEach(function (code) {
              var def = t.spec.c[code], d = cells[code];
              if (!def || def.length < 3 || d.bad || d.v === null || d.v === 0 || d.v === '') return;
              var ctx = { form: fctx, table: t, item: base.kind === 'item' ? base : null, vars: {} };
              var ok = ev.eval(condTrue[def[2]], ctx);
              if (isUnk(ok) || truthy(ok)) return;
              findings.push({
                sev: 'warning', code: 'SPEC-NOT-APPLICABLE', kind: 'cell', form: name, table: tn, cell: code,
                item: base.kind === 'item' ? base.index : undefined, line: d.line, loc: d.loc, value: d.v,
                label: SPEC.cellLabel(t.spec, code),
                msg: name + ' / ' + tn + ' / ' + code + ' has a value (' + fmt(d.v) + '), but the specification marks this cell as not used in ' +
                  spec.report + ' (condition: ' + spec.conds[def[2]] + ').'
              });
            });
          });
        });
      });
    });

    spec.rules.forEach(function (r) {
      var left, right, pre, loop;
      try {
        left = ast(r, 'l', r[2]);
        right = ast(r, 'r', r[4]);
        pre = r[7] ? ast(r, 'p', r[7]) : null;
        loop = r[6] ? ast(r, 'o', r[6]) : null;
      } catch (e) {
        skip('other', 'a formula this tool cannot read');
        return;
      }
      // A schedule the BSP derives cannot be "submitted" or "missing".
      if (r[0].slice(0, 4) === 'REQ-') {
        var subject = firstForm(spec, [left]);
        if (subject && !spec.formByName[subject].x) { stats.notApplicable++; return; }
      }

      var contexts;
      if (loop) {
        var rows = ev.rows(loop, ev.global);
        if (isUnk(rows)) { skip(reasonGroup(rows.why), rows.why); return; }
        contexts = rows.map(function (row) {
          return row.kind === 'item'
            ? { form: row.table.form, table: row.table, item: row, vars: {} }
            : { form: row, table: null, item: null, vars: {} };
        });
        if (!contexts.length) { stats.notApplicable++; return; }
      } else {
        contexts = [ev.global];
      }

      var outcome = 'na';
      for (var i = 0; i < contexts.length; i++) {
        var ctx = contexts[i];
        if (pre) {
          var p = scalar(ev.eval(pre, ctx));
          if (isUnk(p)) { outcome = worst(outcome, 'skip'); skipWhy(p.why); continue; }
          if (!truthy(p)) continue;
        }
        var L = scalar(ev.eval(left, ctx));
        if (isUnk(L)) { outcome = worst(outcome, 'skip'); skipWhy(L.why); continue; }
        var R = scalar(ev.eval(right, ctx));
        if (isUnk(R)) { outcome = worst(outcome, 'skip'); skipWhy(R.why); continue; }
        if (compare(L, r[3], R, r[5])) { outcome = worst(outcome, 'pass'); continue; }
        outcome = 'fail';
        findings.push(ruleFinding(r, left, right, loop, ctx, L, R));
      }
      if (outcome === 'fail') stats.failed++;
      else if (outcome === 'pass') stats.passed++;
      else if (outcome === 'skip') stats.skippedTotal++;
      else stats.notApplicable++;

      function skipWhy(why) {
        var g = reasonGroup(why);
        if (!r._counted) { stats.skipped[g] = (stats.skipped[g] || 0) + 1; r._counted = true; }
        stats.skippedWhy[why] = (stats.skippedWhy[why] || 0) + 1;
      }
      function skip(group, why) {
        stats.skipped[group] = (stats.skipped[group] || 0) + 1;
        stats.skippedWhy[why] = (stats.skippedWhy[why] || 0) + 1;
        stats.skippedTotal++;
      }
    });
    spec.rules.forEach(function (r) { delete r._counted; });

    function worst(a, b) {
      var rank = { na: 0, pass: 1, skip: 2, fail: 3 };
      return rank[b] > rank[a] ? b : a;
    }

    function ruleFinding(r, left, right, loop, ctx, L, R) {
      var lhs = ev.operands(left, ctx, 14), rhs = ev.operands(right, ctx, 14);
      var form = (ctx.form && ctx.form.spec.n) || firstForm(spec, [left, right]) || '';
      var anchor = lhs.concat(rhs).filter(function (o) { return o.line !== undefined || o.loc; })[0];
      var f = {
        sev: r[8] ? 'warning' : 'error', code: r[0], kind: 'rule', msg: r[1], form: form,
        left: L, right: R, op: r[3], tol: r[5], lhsText: r[2], rhsText: r[4], pre: r[7] || '',
        lhs: lhs, rhs: rhs, line: anchor && anchor.line, loc: anchor && anchor.loc
      };
      if (ctx.item) {
        f.table = ctx.table.spec.n;
        f.item = ctx.item.index;
        f.line = f.line === undefined ? ctx.item.data.line : f.line;
      }
      if (typeof L === 'number' && typeof R === 'number') f.diff = L - R;
      // An empty sheet of the Excel template may still count as a nil schedule.
      if (doc.source === 'xlsx' && /^Required schedule/.test(r[1])) {
        f.sev = 'warning';
        f.note = 'The sheet has no values. If the schedule is nil, check with the BSP whether an empty sheet is accepted.';
      }
      return f;
    }

    return finish(result);
  }

  function finish(result) {
    var c = { error: 0, warning: 0, info: 0 };
    result.findings.forEach(function (f) { c[f.sev]++; });
    result.counts = c;
    result.verdict = c.error ? 'error' : c.warning ? 'warning' : 'ok';
    return result;
  }

  function fmt(v) {
    if (v === null || v === undefined) return '(blank)';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v !== 'number') return String(v);
    var r = Math.round(v * 1e6) / 1e6;
    var parts = String(Math.abs(r)).split('.');
    if (/e/.test(parts[0])) return String(r);
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (parts[1] && parts[1].length === 1) parts[1] += '0';
    return (r < 0 ? '-' : '') + parts.join('.');
  }

  return {
    readXml: readXml, readXmlBytes: readXmlBytes, decode: decode, check: check, checkValue: checkValue, typeWords: typeWords,
    Evaluator: Evaluator, compare: compare, fmt: fmt, isUnknown: isUnk, show: show
  };
});
