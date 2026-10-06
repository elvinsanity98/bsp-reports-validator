// Reads a filled-in BSP Excel input template (<REPORT>_input_template.xlsx)
// into the same document shape the XML reader produces, so the same checks run
// on it. Runs in the browser and in Node 18+ (both have DecompressionStream).
//
//   BSPV.template.read(bytes, spec, { Undertaking, Year, Period }).then(function (doc) { ... })
//
// How a sheet is laid out (one sheet per schedule, named after it):
//   column A   the name of a table or field starts a section
//   one row    the column codes C0010, C0020, ...
//   fixed grid every row carries its row code R0010, R0020, ... left of the values
//   list       every filled row under the column codes is one entry
//   field      the value sits two rows under the field name, in column A
(function (root, factory) {
  var api;
  if (typeof module !== 'undefined' && module.exports) {
    api = module.exports = factory(require('./xml.js'), require('./engine.js'), require('./spec.js'));
  } else {
    api = factory(root.BSPV.xml, root.BSPV.engine, root.BSPV.spec);
  }
  (root.BSPV = root.BSPV || {}).template = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (XML, ENGINE, SPEC) {
  'use strict';

  // ---- zip -------------------------------------------------------------------

  function unzip(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not an Excel .xlsx file (it is not a ZIP archive).');
    var count = view.getUint16(eocd + 10, true), p = view.getUint32(eocd + 16, true);
    var names = new TextDecoder('utf-8'), entries = {};
    for (var n = 0; n < count && p + 46 <= bytes.length; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
      entries[names.decode(bytes.subarray(p + 46, p + 46 + nameLen))] = {
        flags: view.getUint16(p + 8, true), method: view.getUint16(p + 10, true),
        size: view.getUint32(p + 20, true), offset: view.getUint32(p + 42, true)
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    function read(name) {
      var e = entries[name];
      if (!e) return Promise.resolve(null);
      if (e.flags & 1) return Promise.reject(new Error('The workbook is password-protected. Remove the password and try again.'));
      var start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
      var body = bytes.subarray(start, start + e.size);
      if (e.method === 0) return Promise.resolve(new TextDecoder('utf-8').decode(body));
      if (e.method !== 8) return Promise.reject(new Error('The workbook uses a compression method this tool cannot read.'));
      if (typeof DecompressionStream === 'undefined') {
        return Promise.reject(new Error('This browser cannot open .xlsx files. Use a current Chrome, Edge or Firefox.'));
      }
      var stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    return { names: Object.keys(entries), has: function (name) { return !!entries[name]; }, read: read };
  }

  // ---- workbook --------------------------------------------------------------

  function kids(el, name) { return el.children.filter(function (c) { return c.name === name; }); }
  function kid(el, name) { return kids(el, name)[0]; }

  function colIndex(ref) {
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n;
  }
  function colName(n) {
    var s = '';
    while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function richText(el) {
    var out = '';
    el.children.forEach(function (c) {
      if (c.name === 't') out += c.text;
      else if (c.name === 'r') kids(c, 't').forEach(function (t) { out += t.text; });
    });
    return out;
  }

  // Returns { sheets: [{ name, rows: { rowNumber: { colNumber: value } } }] }.
  // A value is a string, a number, or { error: '#REF!' }.
  async function readWorkbook(bytes) {
    var zip = unzip(bytes);
    var wbXml = await zip.read('xl/workbook.xml');
    if (!wbXml) throw new Error('This file is not an Excel workbook (.xlsx). Older .xls files must be saved as .xlsx first.');
    var wb = XML.parse(wbXml).root;
    var rels = {};
    var relXml = await zip.read('xl/_rels/workbook.xml.rels');
    if (relXml) {
      XML.parse(relXml).root.children.forEach(function (r) {
        var t = r.attrs.Target || '';
        rels[r.attrs.Id] = t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t;
      });
    }
    var strings = [];
    var ssXml = await zip.read('xl/sharedStrings.xml');
    if (ssXml) kids(XML.parse(ssXml).root, 'si').forEach(function (si) { strings.push(richText(si)); });

    var sheets = [];
    var list = kid(wb, 'sheets') ? kids(kid(wb, 'sheets'), 'sheet') : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var path = rels[s.attrs['r:id']] || 'xl/worksheets/sheet' + (i + 1) + '.xml';
      var xml = await zip.read(path);
      var rows = {};
      if (xml) {
        var data = kid(XML.parse(xml).root, 'sheetData');
        (data ? kids(data, 'row') : []).forEach(function (row, ri) {
          var rn = parseInt(row.attrs.r, 10) || ri + 1, next = 1, cells = null;
          row.children.forEach(function (c) {
            if (c.name !== 'c') return;
            var cn = c.attrs.r ? colIndex(c.attrs.r) : next;
            next = cn + 1;
            var t = c.attrs.t, v = kid(c, 'v'), value;
            if (t === 'inlineStr') value = kid(c, 'is') ? richText(kid(c, 'is')) : '';
            else if (!v) return;
            else if (t === 's') value = strings[parseInt(v.text, 10)] || '';
            else if (t === 'str') value = v.text;
            else if (t === 'e') value = { error: v.text };
            else if (t === 'b') value = v.text === '1' ? 'TRUE' : 'FALSE';
            else value = v.text.trim() === '' ? '' : Number(v.text);
            if (value === '') return;
            (cells = cells || (rows[rn] = {}))[cn] = value;
          });
        });
      }
      sheets.push({ name: s.attrs.name, rows: rows });
    }
    return { sheets: sheets };
  }

  // ---- template sheets -> document -------------------------------------------

  function isoFromSerial(n) {
    var d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }

  // Text the XML would carry for a spreadsheet value of the given type.
  function toRaw(value, type) {
    if (typeof value === 'number') {
      if (type.b === 'D') return isoFromSerial(value);
      if (type.b === 's') return String(value);
      // Formula results carry floating-point dust (1234.5600000000001); drop it.
      var places = type.fd !== undefined ? Number(type.fd) : type.b === 'i' ? 0 : 6;
      var rounded = Number(value.toFixed(places));
      var v = Math.abs(value - rounded) <= 1e-9 * Math.max(1, Math.abs(value)) ? rounded : value;
      var s = String(v);
      return /e/i.test(s) ? v.toFixed(Math.min(20, places + 4)).replace(/\.?0+$/, '') : s;
    }
    var text = String(value);
    if (type.enum) {
      var m = /\[([^\]]+)\]\s*$/.exec(text);
      return m ? m[1].trim() : text.trim();
    }
    if (type.b === 'D') return text.trim().replace(/\//g, '-');
    if (type.b === 'd' || type.b === 'i') return text.trim();
    return text;
  }

  function readTemplate(book, spec, header) {
    var doc = { source: 'xlsx', header: {}, forms: {}, findings: [], sheets: [] };
    function add(sev, code, msg, loc, extra) {
      var f = { sev: sev, code: code, kind: 'file', msg: msg, loc: loc };
      if (extra) Object.keys(extra).forEach(function (k) { f[k] = extra[k]; });
      doc.findings.push(f);
    }

    spec.header.forEach(function (h) {
      var given = header && header[h[0]];
      if (given === undefined || given === null || String(given).trim() === '') {
        add('error', 'XSD-HEADER', h[0] + ' is not filled in. The Excel template has no place for it; enter it above before checking.', undefined, { form: 'Header', cell: h[0] });
        return;
      }
      var r = ENGINE.checkValue(spec.types[h[1]], String(given).trim());
      if (r.err) {
        add('error', 'XSD-TYPE', 'Header / ' + h[0] + ': "' + given + '" ' + r.err + '.', undefined, { form: 'Header', cell: h[0] });
        doc.header[h[0]] = { raw: String(given), v: null, bad: true };
      } else {
        doc.header[h[0]] = { raw: String(given), v: r.v };
      }
    });

    var matched = 0;
    book.sheets.forEach(function (sheet) {
      var form = spec.formByName[sheet.name.trim()];
      if (!form || !form.x) return;
      matched++;
      doc.sheets.push(form.n);
      var rows = sheet.rows;
      var rowNos = Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
      var lastRow = rowNos.length ? rowNos[rowNos.length - 1] : 0;
      var inst = { name: form.n, fields: {}, tables: {} };
      var filled = 0;

      function value(cellValue, type, loc, where, at) {
        if (cellValue !== null && typeof cellValue === 'object') {
          add('error', 'TPL-ERROR-VALUE', where + ' (' + loc + ') holds the Excel error ' + cellValue.error + '.', loc, at);
          return { raw: cellValue.error, v: null, bad: true, loc: loc };
        }
        var raw = toRaw(cellValue, type);
        var r = ENGINE.checkValue(type, raw);
        if (r.err) {
          add('error', 'XSD-TYPE', where + ' (' + loc + '): "' + raw.slice(0, 60) + '" ' + r.err + '.', loc, at);
          return { raw: raw, v: null, bad: true, loc: loc };
        }
        return { raw: raw, v: r.v, loc: loc };
      }

      // sections: a table or field name in column A
      var marks = [];
      rowNos.forEach(function (rn) {
        var a = rows[rn][1];
        if (typeof a !== 'string' || rn <= 2) return;
        var name = a.trim();
        var table = form.tableByName[name];
        if (table && table.x) marks.push({ row: rn, table: table });
        else if (form.fieldByName[name]) marks.push({ row: rn, field: form.fieldByName[name] });
        else if (form.z && form.z.f === name) marks.push({ row: rn, field: [form.z.f, form.z.ty, form.z.t] });
      });

      marks.forEach(function (mark, mi) {
        var end = mi + 1 < marks.length ? marks[mi + 1].row - 1 : lastRow;
        if (mark.field) {
          var fv = rows[mark.row + 2] && rows[mark.row + 2][1];
          if (fv === undefined) return;
          var floc = sheet.name + '!A' + (mark.row + 2);
          inst.fields[mark.field[0]] = value(fv, spec.types[mark.field[1]], floc, form.n + ' / ' + mark.field[0], { form: form.n, cell: mark.field[0] });
          filled++;
          return;
        }
        var table = mark.table;
        var inSection = rowNos.filter(function (rn) { return rn > mark.row && rn <= end; });

        // the row of column codes
        var codeRow = 0, colCodes = {};
        for (var k = 0; k < inSection.length && !codeRow; k++) {
          var r = rows[inSection[k]];
          for (var c in r) {
            if (typeof r[c] === 'string' && /^C\d{4}$/.test(r[c].trim())) { colCodes[c] = r[c].trim(); codeRow = inSection[k]; }
          }
        }
        var cols = Object.keys(colCodes).map(Number).sort(function (a, b) { return a - b; });
        var body = inSection.filter(function (rn) { return rn > codeRow; });

        function rowCodeOf(r, pattern) {
          for (var c = 2; c <= 6; c++) {
            if (typeof r[c] === 'string' && pattern.test(r[c].trim()) && !colCodes[c]) return { code: r[c].trim(), col: c };
          }
          return null;
        }
        function notInput(def, code, loc, v) {
          if (v === 0) return;
          add('warning', 'TPL-NOT-INPUT', def
            ? form.n + ' / ' + table.n + ' / ' + code + ' (' + loc + ') is a total the BSP works out itself; the value typed there is ignored.'
            : form.n + ' / ' + table.n + ' / ' + code + ' (' + loc + ') is not a cell of this table; the value typed there is ignored.',
            loc, { form: form.n, table: table.n, cell: code });
        }

        if (table.k === 'S') {
          var cells = {};
          body.forEach(function (rn) {
            var r = rows[rn], rc = rowCodeOf(r, /^R\d{4}$/);
            if (!rc) return;
            cols.forEach(function (c) {
              if (r[c] === undefined) return;
              var code = rc.code + colCodes[c], def = table.c[code], loc = sheet.name + '!' + colName(c) + rn;
              if (!def || def[0] !== 0) { notInput(def, code, loc, r[c]); return; }
              cells[code] = value(r[c], spec.types[Array.isArray(def[1]) ? def[1][0] : def[1]], loc,
                form.n + ' / ' + table.n + ' / ' + code, { form: form.n, table: table.n, cell: code });
              filled++;
            });
          });
          if (Object.keys(cells).length) inst.tables[table.n] = { cells: cells };
          return;
        }

        var items = [];
        function pushItem(cells, where) {
          var itemNo = items.length;
          Object.keys(table.c).forEach(function (code) {
            var def = table.c[code];
            if (def[0] === 0 && Array.isArray(def[1]) && !cells[code]) {
              add('error', 'XSD-REQUIRED', form.n + ' / ' + table.n + ' entry ' + (itemNo + 1) + ' (' + where + ') has no ' + code +
                (SPEC.cellLabel(table, code) ? ' (' + SPEC.cellLabel(table, code) + ')' : '') + ', which every entry must have.',
                where, { form: form.n, table: table.n, cell: code, item: itemNo });
            }
          });
          Object.keys(cells).forEach(function (code) { cells[code].item = itemNo; });
          items.push({ index: itemNo, cells: cells, loc: where });
          filled++;
        }

        if (table.k === 'Y') {
          body.forEach(function (rn) {
            var r = rows[rn], cells = {};
            cols.forEach(function (c) {
              if (r[c] === undefined) return;
              var code = colCodes[c], def = table.c[code], loc = sheet.name + '!' + colName(c) + rn;
              if (!def || def[0] !== 0) return;   // sequence number and looked-up columns
              cells[code] = value(r[c], spec.types[Array.isArray(def[1]) ? def[1][0] : def[1]], loc,
                form.n + ' / ' + table.n + ' / ' + code, { form: form.n, table: table.n, cell: code, item: items.length });
            });
            if (Object.keys(cells).length) pushItem(cells, sheet.name + '!row ' + rn);
          });
        } else {
          // one entry per column (or per group of coded columns), rows carry the codes
          var coded = [];
          inSection.forEach(function (rn) {
            var rc = rowCodeOf(rows[rn], /^[A-Z][A-Z0-9_]*$/);
            if (rc && rn !== codeRow) coded.push({ row: rn, code: rc.code, col: rc.col });
          });
          if (!coded.length) return;
          var firstCol = coded[0].col + 1, maxCol = firstCol;
          coded.forEach(function (rc) { for (var c in rows[rc.row]) maxCol = Math.max(maxCol, Number(c)); });
          var groups = [];
          if (cols.length) {
            var width = 0;
            cols.forEach(function (c, i) { if (i === 0 || colCodes[c] === colCodes[cols[0]]) { groups.push([]); } groups[groups.length - 1].push(c); width++; });
          } else {
            for (var gc = firstCol; gc <= maxCol; gc++) groups.push([gc]);
          }
          groups.forEach(function (group) {
            var cells = {};
            coded.forEach(function (rc) {
              group.forEach(function (c, gi) {
                var v = rows[rc.row][c];
                if (v === undefined) return;
                var code = rc.code + (cols.length && table.c[rc.code + colCodes[c]] ? colCodes[c] : '');
                if (!table.c[code] && gi > 0) return;
                var def = table.c[code], loc = sheet.name + '!' + colName(c) + rc.row;
                if (!def || def[0] !== 0) return;
                cells[code] = value(v, spec.types[Array.isArray(def[1]) ? def[1][0] : def[1]], loc,
                  form.n + ' / ' + table.n + ' / ' + code, { form: form.n, table: table.n, cell: code, item: items.length });
              });
            });
            if (Object.keys(cells).length) pushItem(cells, sheet.name + '!column ' + colName(group[0]));
          });
        }
        if (items.length) inst.tables[table.n] = { items: items };
      });

      if (filled) doc.forms[form.n] = [inst];
    });

    if (!matched) {
      add('error', 'TPL-NO-SHEETS', 'No sheet of this workbook is named after a ' + spec.report + ' schedule (FRP_1, FRP_BS, ...). ' +
        'Use the BSP input template for ' + spec.report + ' version ' + spec.version + ' and keep its sheet names.');
      doc.fatal = true;
    }
    return doc;
  }

  function read(bytes, spec, header) {
    return readWorkbook(bytes).then(function (book) { return readTemplate(book, spec, header); });
  }

  return { read: read, readWorkbook: readWorkbook, readTemplate: readTemplate, unzip: unzip, colName: colName, toRaw: toRaw };
});
