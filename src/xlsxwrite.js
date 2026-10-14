// A small .xlsx writer: sheets of numbers and text with a handful of styles,
// compressed with the browser's (or Node's) own deflate. Enough to write a
// report in the layout of the BSP input template; no formulas, no charts.
//
//   BSPV.xlsxwrite.write([{ name, cols: [widths], freeze: 'E9', rows: { 9: { 5: { v: 1.5, s: 'amount' } } } }])
//     -> Promise of Uint8Array
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.BSPV = root.BSPV || {}).xlsxwrite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Styles a cell can name. The order is the cellXfs order in styles.xml.
  var STYLES = ['default', 'title', 'header', 'code', 'label', 'amount', 'count', 'text', 'calc', 'marker', 'blocked', 'subtitle', 'number'];
  var STYLE_ID = {};
  STYLES.forEach(function (s, i) { STYLE_ID[s] = i; });

  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;-#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/></numFmts>' +
    '<fonts count="4">' +
      '<font><sz val="10"/><name val="Arial"/></font>' +
      '<font><b/><sz val="10"/><name val="Arial"/></font>' +
      '<font><b/><sz val="12"/><name val="Arial"/></font>' +
      '<font><sz val="8"/><color rgb="FF595959"/><name val="Arial"/></font>' +
    '</fonts>' +
    '<fills count="6">' +
      '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF8497B0"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFAEAAAA"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE4B5"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>' +
      '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="13">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                                        // default
      '<xf numFmtId="0" fontId="2" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +                             // title
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +                                                 // header
      '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center"/></xf>' +                                                                                // code
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' + // label
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyProtection="1"><protection locked="0"/></xf>' + // amount
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyProtection="1"><protection locked="0"/></xf>' + // count
      '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyProtection="1"><protection locked="0"/></xf>' + // text
      '<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>' +    // calc
      '<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +                             // marker
      '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>' +                           // blocked
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                                           // subtitle
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyProtection="1"><protection locked="0"/></xf>' + // number
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      // characters XML 1.0 cannot carry at all
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(n) {
    var s = '';
    while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function sheetXml(sheet) {
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
    if (sheet.freeze) {
      var m = /^([A-Z]+)(\d+)$/.exec(sheet.freeze);
      var col = 0;
      for (var i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
      var xs = col - 1, ys = Number(m[2]) - 1;
      out.push('<sheetViews><sheetView workbookViewId="0"><pane' + (xs ? ' xSplit="' + xs + '"' : '') + (ys ? ' ySplit="' + ys + '"' : '') +
        ' topLeftCell="' + sheet.freeze + '" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>');
    }
    if (sheet.cols && sheet.cols.length) {
      out.push('<cols>' + sheet.cols.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>');
    }
    out.push('<sheetData>');
    Object.keys(sheet.rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      var row = sheet.rows[r], cells = [];
      Object.keys(row).map(Number).sort(function (a, b) { return a - b; }).forEach(function (c) {
        var cell = row[c], ref = colName(c) + r, s = STYLE_ID[cell.s || 'default'] || 0;
        var attr = ' r="' + ref + '"' + (s ? ' s="' + s + '"' : '');
        if (cell.v === undefined || cell.v === null || cell.v === '') cells.push('<c' + attr + '/>');
        else if (typeof cell.v === 'number' && isFinite(cell.v)) cells.push('<c' + attr + '><v>' + cell.v + '</v></c>');
        else cells.push('<c' + attr + ' t="inlineStr"><is><t xml:space="preserve">' + esc(cell.v) + '</t></is></c>');
      });
      out.push('<row r="' + r + '"' + (sheet.heights && sheet.heights[r] ? ' ht="' + sheet.heights[r] + '" customHeight="1"' : '') + '>' + cells.join('') + '</row>');
    });
    out.push('</sheetData>');
    out.push('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
    out.push('</worksheet>');
    return out.join('');
  }

  // ---- zip ---------------------------------------------------------------------

  var CRC = null;
  function crc32(bytes) {
    if (!CRC) {
      CRC = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function zip(files) {
    var enc = new TextEncoder(), names = Object.keys(files);
    return Promise.all(names.map(function (n) {
      var raw = enc.encode(files[n]);
      return deflate(raw).then(function (packed) {
        return { name: enc.encode(n), raw: raw, body: packed || raw, method: packed ? 8 : 0, crc: crc32(raw) };
      });
    })).then(function (entries) {
      var parts = [], central = [], offset = 0;
      entries.forEach(function (e) {
        var head = new DataView(new ArrayBuffer(30));
        head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, e.method, true);
        head.setUint32(14, e.crc, true); head.setUint32(18, e.body.length, true); head.setUint32(22, e.raw.length, true); head.setUint16(26, e.name.length, true);
        var cen = new DataView(new ArrayBuffer(46));
        cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, e.method, true);
        cen.setUint32(16, e.crc, true); cen.setUint32(20, e.body.length, true); cen.setUint32(24, e.raw.length, true); cen.setUint16(28, e.name.length, true);
        cen.setUint32(42, offset, true);
        parts.push(new Uint8Array(head.buffer), e.name, e.body);
        central.push(new Uint8Array(cen.buffer), e.name);
        offset += 30 + e.name.length + e.body.length;
      });
      var cdSize = central.reduce(function (s, p) { return s + p.length; }, 0);
      var end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
      var all = parts.concat(central, [new Uint8Array(end.buffer)]);
      var total = all.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(total), at = 0;
      all.forEach(function (p) { out.set(p, at); at += p.length; });
      return out;
    });
  }

  // sheets: [{ name, rows: { r: { c: { v, s } } }, cols, freeze, heights }]
  function write(sheets) {
    var files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
        '</Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map(function (s, i) { return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
        '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
      'xl/styles.xml': STYLES_XML
    };
    sheets.forEach(function (s, i) { files['xl/worksheets/sheet' + (i + 1) + '.xml'] = sheetXml(s); });
    return zip(files);
  }

  return { write: write, colName: colName, STYLES: STYLES };
});
