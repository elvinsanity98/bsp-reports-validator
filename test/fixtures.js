// Builders for test and sample files.
const zlib = require('zlib');
const ENGINE = require('../src/engine.js');

const RB = { bank: { BNKGRP: 'RB', PARENTBNKGRP: 'NONE', A_TRUST: 0, A_EMI: 0, ISDOMESTIC: 1, BRANCHCOUNT: 2, DOMESTICBRANCHCOUNT: 2 },
  branches: { '001': { REGION: '9', BRISLOC: '4' }, '002': { REGION: '9', BRISLOC: '4' } } };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// forms: { FRP_1: { MAIN: { R0020C0010: 100 }, LIST: [{ C0010: 'x' }], '@Field': 1 } }
// A schedule mapped to {} is written as an empty element.
function buildXml(spec, opts) {
  const o = Object.assign({ undertaking: 'RB0001', year: 2026, period: 3, from: '2026-09-18', to: '2026-09-24', forms: {} }, opts);
  const header = { Undertaking: o.undertaking, Year: o.year, Period: o.period, FromDate: o.from, ToDate: o.to };
  const out = ['<?xml version="1.0" encoding="utf-8"?>', `<${spec.root} xmlns="${spec.ns}">`, '  <Header>',
    ...spec.header.map((h) => `    <${h[0]}>${esc(header[h[0]])}</${h[0]}>`), '  </Header>'];
  const cells = (obj, pad) => Object.keys(obj).map((c) => `${pad}<${c}>${esc(obj[c])}</${c}>`);
  for (const form of spec.forms) {
    const data = o.forms[form.n];
    if (!data) continue;
    const keys = Object.keys(data);
    if (!keys.length) { out.push(`  <${form.n}/>`); continue; }
    out.push(`  <${form.n}>`);
    for (const k of keys) {
      if (k[0] === '@') { out.push(`    <${k.slice(1)}>${esc(data[k])}</${k.slice(1)}>`); continue; }
      const table = form.tableByName[k];
      out.push(`    <${k}>`);
      if (Array.isArray(data[k])) {
        const item = (table && table.item) || k + '_Item';
        for (const row of data[k]) out.push(`      <${item}>`, ...cells(row, '        '), `      </${item}>`);
      } else {
        out.push(...cells(data[k], '      '));
      }
      out.push(`    </${k}>`);
    }
    out.push(`  </${form.n}>`);
  }
  out.push(`</${spec.root}>`, '');
  return out.join('\n');
}

// The schedules the rules require for a period and bank profile.
function requiredForms(spec, period, profile, year) {
  const doc = ENGINE.readXml(buildXml(spec, { period, year: year || 2026 }), spec);
  const r = ENGINE.check(spec, doc, { profile });
  return r.findings.filter((f) => /^Required schedule/.test(f.msg)).map((f) => f.form);
}

// ---- a minimal .xlsx writer (stored, no compression) -------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(files, deflate) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8'), raw = Buffer.from(text, 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(crc32(raw), 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc32(raw), 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    local.push(head, nameBuf, body);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

// sheets: { FRP_1: { A1: 'FRP_1', E9: 1500.25 } }
function makeXlsx(sheets, deflate) {
  const names = Object.keys(sheets);
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names.map((n, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>'
  };
  names.forEach((n, i) => {
    const rows = {};
    for (const [ref, v] of Object.entries(sheets[n])) {
      const r = Number(/\d+$/.exec(ref)[0]);
      (rows[r] = rows[r] || []).push(typeof v === 'number'
        ? `<c r="${ref}"><v>${v}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`);
    }
    files[`xl/worksheets/sheet${i + 1}.xml`] = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      Object.keys(rows).map(Number).sort((a, b) => a - b).map((r) => `<row r="${r}">${rows[r].join('')}</row>`).join('') + '</sheetData></worksheet>';
  });
  return zip(files, deflate);
}

module.exports = { RB, buildXml, requiredForms, makeXlsx, zip };
