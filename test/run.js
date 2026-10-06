// Run: node test/run.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XML = require('../src/xml.js');
const FORMULA = require('../src/formula.js');
const SPEC = require('../src/spec.js');
const ENGINE = require('../src/engine.js');
const TEMPLATE = require('../src/template.js');
const fx = require('./fixtures.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let spec;

const codes = (r) => r.findings.map((f) => f.code);
const has = (r, code) => codes(r).includes(code);
const checkXml = (xml, opts) => ENGINE.check(spec, ENGINE.readXml(xml, spec), Object.assign({ profile: fx.RB }, opts));
const checkForms = (forms, opts) => checkXml(fx.buildXml(spec, Object.assign({ period: 2, forms }, opts)), opts);
const sample = (name) => fs.readFileSync(path.join(__dirname, '..', 'samples', name), 'utf8');

// ---- XML reader ----------------------------------------------------------------

test('xml: reads elements, text, entities, CDATA and line numbers', () => {
  const d = XML.parse('<?xml version="1.0" encoding="utf-8"?>\n<a xmlns="urn:x">\n  <b>1 &amp; 2 &#65;</b>\n  <c><![CDATA[<raw>]]></c>\n</a>');
  assert.strictEqual(d.root.name, 'a');
  assert.strictEqual(d.root.ns, 'urn:x');
  assert.strictEqual(d.root.children[0].text, '1 & 2 A');
  assert.strictEqual(d.root.children[0].line, 3);
  assert.strictEqual(d.root.children[0].ns, 'urn:x');
  assert.strictEqual(d.root.children[1].text, '<raw>');
  assert.strictEqual(d.decl.encoding, 'utf-8');
});

test('xml: reports what is wrong and where', () => {
  const bad = (text, re, line) => {
    try { XML.parse(text); } catch (e) {
      assert.ok(e instanceof XML.XmlError, text);
      assert.ok(re.test(e.message), e.message);
      if (line) assert.strictEqual(e.line, line);
      return;
    }
    assert.fail('no error for ' + text);
  };
  bad('<a>\n<b>\n</a>', /does not match <b> opened on line 2/, 3);
  bad('<a>', /never closed/);
  bad('<a/><b/>', /second root element/);
  bad('<a x=1/>', /must be in quotes/);
  bad('<a>1 & 2</a>', /&amp;/);
  bad('<a>&nbsp;</a>', /Unknown entity/);
  bad('', /no XML element/);
  bad('<p:a/>', /prefix "p"/);
  bad('<a x="1" x="2"/>', /appears twice/);
});

// ---- formula language ----------------------------------------------------------

test('formula: every formula of the specification parses', () => {
  let n = 0;
  for (const r of spec.rules) for (const i of [2, 4, 6, 7]) if (r[i]) { FORMULA.parse(String(r[i])); n++; }
  for (const f of spec.forms) for (const t of f.tb) for (const c of Object.values(t.c)) if (c[0] === 1) { FORMULA.parse(c[1]); n++; }
  spec.conds.forEach((c) => FORMULA.parse(c));
  assert.ok(n > 60000, String(n));
});

test('formula: precedence and references', () => {
  const t = FORMULA.parse('[A][B][R0010C0010] + 2 * 3 >= 10 AND ISNULL([A]) = FALSE OR $1[C0020] <> "5"');
  assert.strictEqual(t.op, 'OR');
  assert.strictEqual(t.a.op, 'AND');
  assert.strictEqual(t.a.a.op, '>=');
  assert.strictEqual(t.a.a.a.b.op, '*');
  assert.deepStrictEqual(t.b.a, { t: 'ref', scope: '$1', path: ['C0020'] });
  const s = FORMULA.parse('SUMIF([F][L]:$1; $1[C0020]="1"; $1[C0060])');
  assert.strictEqual(s.args[0].t, 'iter');
  assert.strictEqual(s.args[0].v, '$1');
  assert.deepStrictEqual(FORMULA.parse('$0[MAIN_Y1]').scope, '$0');
  assert.throws(() => FORMULA.parse('1 +'), /ends too early/);
  assert.throws(() => FORMULA.parse('FOO'), /Unknown word/);
});

test('compare: tolerance and floating-point noise', () => {
  const c = ENGINE.compare;
  assert.ok(c(0.1 + 0.2, '=', 0.3, 0));
  assert.ok(!c(100.01, '=', 100, 0));
  assert.ok(c(1010000, '=', 1000000, 10000));
  assert.ok(!c(1010000.01, '=', 1000000, 10000));
  assert.ok(c(0, '>=', 0, 0) && !c(-0.01, '>=', 0, 0));
  assert.ok(!c(0.3, '<', 0.3, 0) && c(0.299999, '<', 0.3, 0));
  assert.ok(!c(0, '>', 0, 0) && c(0.01, '>', 0, 0));
  assert.ok(c(null, '=', 0, 0) && c('1', '=', 1, 0) && c('RB', '=', 'RB', 0) && !c('RB', '=', 'TB', 0));
  assert.ok(!c('001', '=', '01', 0), 'two texts compare as text');
  assert.ok(c(true, '=', 1, 0) && c(false, '<>', true, 0));
});

// ---- value formats -------------------------------------------------------------

test('value formats follow the XSD types', () => {
  const type = (n) => spec.types.find((t) => t.n === n);
  const amount = type('Ptype_amount'), pos = type('Ptype_amount_pos'), count = type('Ptype_number_of9');
  const ok = (t, raw, v) => assert.deepStrictEqual(ENGINE.checkValue(t, raw), { v }, raw);
  const bad = (t, raw, re) => { const r = ENGINE.checkValue(t, raw); assert.ok(r.err && re.test(r.err), raw + ' -> ' + JSON.stringify(r)); };
  ok(amount, '1500.25', 1500.25); ok(amount, '-3', -3); ok(amount, ' 12.5 ', 12.5); ok(amount, '0', 0); ok(amount, '.5', 0.5);
  bad(amount, '1,500.25', /comma/); bad(amount, '', /empty/); bad(amount, '12.345', /more than 2 decimal/);
  bad(amount, '(500)', /brackets/); bad(amount, '1.5E3', /scientific/); bad(amount, 'abc', /not a number/);
  bad(amount, '+5', /plus sign/); bad(amount, '123456789012345678', /maximum|digits/);
  bad(pos, '-1', /negative/);
  ok(count, '12', 12); bad(count, '1.5', /decimals/); bad(count, '-2', /negative/); bad(count, '1234567890', /maximum/);
  const date = spec.types.find((t) => t.b === 'D');
  ok(date, '2026-02-28', '2026-02-28'); bad(date, '2026-02-30', /real calendar/); bad(date, '02/28/2026', /YYYY-MM-DD/);
  const name = type('Ptype_char50.1');
  ok(name, 'ABC Corp', 'ABC Corp'); bad(name, '', /empty/); bad(name, 'x'.repeat(51), /limit is 50/); bad(name, ' ABC', /starts with a space/);
  const voting = type('EnumList_VOTING_IND_4');
  ok(voting, '1', '1'); bad(voting, '3', /not an allowed code/);
});

// ---- reading the XML against the schema ----------------------------------------

test('schema: unknown, calculated, duplicated and misplaced elements', () => {
  const xml = fx.buildXml(spec, { period: 2, forms: { MLR_II: { MAIN: { R0010C0010: '1', R0090C0010: '5', R7777C0010: '1' } }, MICRO_MBS: {}, MLR_III: {} } })
    .replace('<MLR_III/>', '<MLR_III/>\n  <MLR_III/>\n  <NOPE/>\n  <MLR_I/>\n  <MSME_1A><MAIN>text<R0010C0010 unit="php">1</R0010C0010><R0010C0010>2</R0010C0010></MAIN></MSME_1A>');
  const r = checkXml(xml);
  const msgs = r.findings.filter((f) => f.kind === 'file').map((f) => f.code + ' ' + f.msg);
  const expect = (re) => assert.ok(msgs.some((m) => re.test(m)), String(re) + '\n' + msgs.join('\n'));
  expect(/XSD-CALCULATED MLR_II \/ MAIN \/ R0090C0010/);
  expect(/XSD-UNKNOWN MLR_II \/ MAIN \/ R7777C0010/);
  expect(/XSD-DUPLICATE <MLR_III> appears more than once/);
  expect(/XSD-UNKNOWN <NOPE> is not a schedule/);
  expect(/XSD-CALCULATED Schedule MLR_I is put together by the BSP/);
  expect(/XSD-TEXT/);
  expect(/XSD-ATTRIBUTE Attribute unit/);
  expect(/XSD-DUPLICATE MSME_1A \/ MAIN \/ R0010C0010/);
  assert.ok(r.findings.filter((f) => f.code === 'XSD-CALCULATED')[0].line > 0);
});

test('schema: root, namespace and header', () => {
  let r = checkXml('<Other/>');
  assert.ok(has(r, 'XSD-ROOT') && r.doc.fatal);
  r = checkXml(fx.buildXml(spec, { period: 2 }).replace(/ xmlns="[^"]+"/, ''));
  assert.ok(has(r, 'XSD-NAMESPACE'));
  r = checkXml(fx.buildXml(spec, { period: 2 }).replace('15.0"', '14.0"'));
  assert.ok(has(r, 'XSD-NAMESPACE'));
  r = checkXml(fx.buildXml(spec, { period: 13 }));
  assert.ok(r.findings.some((f) => f.code === 'XSD-TYPE' && /Header \/ Period/.test(f.msg)));
  r = checkXml(fx.buildXml(spec, { period: 2 }).replace(/<Period>2<\/Period>\s*/, ''));
  assert.ok(r.findings.some((f) => f.code === 'XSD-HEADER' && /Period/.test(f.msg)));
  r = checkXml(`<FRP_S xmlns="${spec.ns}"/>`);
  assert.ok(has(r, 'XSD-HEADER'));
  r = checkXml('<FRP_S><Header></FRP_S>');
  assert.ok(has(r, 'XML-WELLFORMED') && r.doc.fatal && r.verdict === 'error');
});

test('schema: list entries need their key; book codes must be unique', () => {
  let r = checkForms({ FRP_6: { MAIN_1A1C: [{ C0010: 'ABC', C0030: '5.00' }, { C0030: '7.00' }] } }, { period: 3 });
  const f = r.findings.find((x) => x.code === 'XSD-REQUIRED');
  assert.ok(f && /entry 2 has no C0010 \(Name\)/.test(f.msg), JSON.stringify(f));
  const xml = fx.buildXml(spec, { period: 3 }).replace('</Header>',
    '</Header>\n<FRP_11A234><FRP_11A234_Item><Bookcode>1</Bookcode></FRP_11A234_Item><FRP_11A234_Item><Bookcode>1</Bookcode></FRP_11A234_Item><FRP_11A234_Item/></FRP_11A234>');
  r = checkXml(xml);
  assert.ok(has(r, 'XSD-UNIQUE') && has(r, 'XSD-REQUIRED') && has(r, 'REQ-FRP_11A234-2'));
});

test('bytes: BOM and declared encodings', () => {
  const xml = fx.buildXml(spec, { period: 2 });
  const utf8bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(xml, 'utf8')]);
  assert.ok(!ENGINE.readXmlBytes(new Uint8Array(utf8bom), spec).fatal);
  const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml.replace('utf-8', 'utf-16'), 'utf16le')]);
  const d = ENGINE.readXmlBytes(new Uint8Array(utf16), spec);
  assert.strictEqual(d.header.Period.v, 2);
  const broken = Buffer.concat([Buffer.from(xml.replace('RB0001', 'RB'), 'utf8').subarray(0, 120), Buffer.from([0xFF]), Buffer.from(xml, 'utf8').subarray(120)]);
  assert.ok(ENGINE.readXmlBytes(new Uint8Array(broken), spec).findings.some((f) => f.code === 'XML-ENCODING'));
});

// ---- rules ---------------------------------------------------------------------

test('samples: clean files have no findings', () => {
  for (const name of ['clean/FRP_S_RB0001_2026-03.xml', 'clean/FRP_S_RB0001_2026-02.xml']) {
    const r = checkXml(sample(name));
    assert.deepStrictEqual(r.findings.map((f) => f.code + ' ' + f.msg), [], name);
    assert.strictEqual(r.verdict, 'ok');
    assert.strictEqual(r.stats.passed + r.stats.failed + r.stats.notApplicable + r.stats.skippedTotal, spec.rules.length);
  }
  const q = checkXml(sample('clean/FRP_S_RB0001_2026-03.xml'));
  assert.ok(q.stats.passed > 8000, String(q.stats.passed));
});

test('samples: the file with errors reports each of them', () => {
  const r = checkXml(sample('with-errors/FRP_S_RB0001_2026-03_errors.xml'));
  for (const code of ['XSD-TYPE', 'XSD-CALCULATED', 'XSD-UNKNOWN', 'SPEC-NOT-APPLICABLE', 'REQ-FRP_11A234-2', 'REQ-FRP_IS-1',
    'RIN-MLR10-8', 'STG1-FRP_BS-USD-PESOEQ-MAIN-R0010C0040', 'STG1-PBS_Solo-POSITIVE_Z-MAIN2-R0160C0010', 'XREQ-BRIS_BS-BRANCH-2']) {
    assert.ok(has(r, code), code + ' missing from ' + codes(r).join(', '));
  }
  assert.strictEqual(r.verdict, 'error');
  const f = r.findings.find((x) => x.code === 'RIN-MLR10-8');
  assert.strictEqual(f.left, 1000000);
  assert.strictEqual(f.right, 900000);
  assert.strictEqual(f.diff, 100000);
  assert.strictEqual(f.tol, 10000);
  assert.strictEqual(f.lhs[0].form, 'FRP_BS');
  assert.strictEqual(f.lhs[0].calc, true);
  assert.strictEqual(f.rhs[0].cell, 'R0010C0010');
  assert.ok(f.rhs[0].line > 0 && /Cash on hand/.test(f.rhs[0].label));
  assert.strictEqual(sample('with-errors/not-well-formed.xml').length > 0 && checkXml(sample('with-errors/not-well-formed.xml')).findings[0].code, 'XML-WELLFORMED');
});

test('rules: required schedules depend on period and bank type', () => {
  const monthly = fx.requiredForms(spec, 2, fx.RB).sort();
  assert.deepStrictEqual(monthly, ['MICRO_MBS', 'MLR_II', 'MLR_III']);
  const quarter = fx.requiredForms(spec, 3, fx.RB);
  assert.ok(quarter.length > 70 && quarter.includes('FRP_BS') && quarter.includes('CAR15_CAR1_S'));
  assert.ok(!quarter.includes('MSME_MR') && !quarter.includes('MLR_I'), 'derived schedules are never asked for');
  assert.ok(!quarter.includes('FRPTI_A1'), 'trust schedules need trust authority');
  const trust = { bank: Object.assign({}, fx.RB.bank, { A_TRUST: 1 }), branches: fx.RB.branches };
  assert.ok(fx.requiredForms(spec, 3, trust).includes('FRPTI_A1'));
  const ukb = { bank: Object.assign({}, fx.RB.bank, { BNKGRP: 'UKB' }), branches: fx.RB.branches };
  assert.ok(fx.requiredForms(spec, 2, ukb).includes('FRP_BS'), 'other bank types file the balance sheet monthly');
});

test('rules: a missing profile fact means "not checked", never a finding', () => {
  const xml = sample('clean/FRP_S_RB0001_2026-03.xml');
  const r = checkXml(xml, { profile: { bank: {} } });
  assert.ok(r.stats.skipped.profile > 50, JSON.stringify(r.stats.skipped));
  assert.ok(r.stats.skipped.branches > 0, JSON.stringify(r.stats.skipped));
  assert.ok(!r.findings.some((f) => /^XREQ/.test(f.code)));
  assert.ok(Object.keys(r.stats.skippedWhy).some((w) => /bank profile: BNKGRP/.test(w)));
});

test('rules: BSP totals are worked out before the rules run', () => {
  const r = checkForms({ MLR_II: { MAIN: { R0010C0010: '100.00', R0100C0010: '40.00', R0120C0010: '2.50' } }, MLR_III: {}, MICRO_MBS: {} });
  const ev = r.evaluator;
  assert.strictEqual(ev.valueOf('MLR_II', 'MAIN', 'R0090C0010'), 42.5);
  assert.strictEqual(ev.valueOf('MLR_II', 'MAIN', 'R0180C0010'), 142.5);
  const x = ev.explain('MLR_II', 'MAIN', 'R0090C0010');
  assert.ok(x.formula && x.inputs.length === 3 && x.inputs[0].value === 40);
  // a derived schedule exists once its sources do
  assert.ok(ev.present('MLR_I') && !ev.present('MSME_MR') && !ev.present('FRP_BS'));
  assert.strictEqual(ev.valueOf('FRP_BS', 'MAIN', 'R0940C0080'), 0);
});

test('rules: list rows, SUMIF over branches, and per-row rules', () => {
  const forms = { BRIS_IR: { MAIN_Y1: [{ C0030: '001', C0190: '0.35' }, { C0030: '002', C0190: '0.12' }] } };
  const r = checkForms(forms, { period: 3 });
  const hit = r.findings.filter((f) => f.code === 'STG1-BRIS_IR_InterestRate_MAIN_Y1_C0190');
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].sev, 'warning');
  assert.strictEqual(hit[0].item, 0);
  assert.strictEqual(hit[0].left, 0.35);
  const q = checkXml(sample('clean/FRP_S_RB0001_2026-03.xml'));
  assert.strictEqual(q.evaluator.valueOf('BRIS_BS', 'MAIN', 'R0040C0140'), 1000000, 'both offices are in Mindanao');
  assert.strictEqual(q.evaluator.valueOf('BRIS_BS', 'MAIN', 'R0010C0140'), 0);
  assert.strictEqual(q.evaluator.valueOf('BRIS_BS', 'MAIN_Y1', 'C0010', 1), 2, 'sequence number');
});

test('rules: earlier periods feed the period-on-period rules', () => {
  const rule = spec.rules.find((r) => r[0] === 'RIN-AAS9-30-8');
  assert.ok(rule && /DWHS\("Y-1"/.test(rule[2]), 'the specification still has this rule');
  const now = fx.buildXml(spec, { year: 2026, period: 12, forms: { FRP_17B: { MAIN: { R0010C0010: '500000.00' } } } });
  const before = (amount) => ENGINE.readXml(fx.buildXml(spec, { year: 2025, period: 12, forms: { FRP_17: { MAIN: { R0010C0030: amount } } } }), spec);
  let r = checkXml(now);
  assert.ok(!has(r, 'RIN-AAS9-30-8') && r.stats.skipped.history > 0);
  assert.ok(Object.keys(r.stats.skippedWhy).includes('earlier period 2025-12'));
  const same = before('500000.00');
  assert.strictEqual(new ENGINE.Evaluator(spec, same, {}).valueOf('FRP_17', 'MAIN', 'R0010C0260'), 500000);
  r = checkXml(now, { history: { '2025-12': same } });
  assert.ok(!has(r, 'RIN-AAS9-30-8'), 'opening balance agrees with last year');
  r = checkXml(now, { history: { '2025-12': before('100000.00') } });
  assert.ok(has(r, 'RIN-AAS9-30-8'));
});

test('rules: periods a rule can point back to', () => {
  const ev = new ENGINE.Evaluator(spec, ENGINE.readXml(fx.buildXml(spec, { year: 2026, period: 2 }), spec), {});
  assert.strictEqual(ev.periodKey('M-1'), '2026-01');
  assert.strictEqual(ev.periodKey('M-2'), '2025-12');
  assert.strictEqual(ev.periodKey('Q-1'), '2025-11');
  assert.strictEqual(ev.periodKey('Y-1'), '2025-02');
  assert.strictEqual(ev.periodKey('YE-1'), '2025-12');
  assert.strictEqual(ev.periodKey('YE-3'), '2023-12');
});

// ---- Excel input template ------------------------------------------------------

function templateBook() {
  return {
    FRP_1: {
      A1: 'FRP_1', A2: 'Checks and Other Cash Items', A4: 'MAIN',
      B5: 'Particulars', E7: 'C0010', F7: 'C0020', L7: 'C0080',
      B8: 'Resident', D8: 'R0010', L8: 99,
      B9: '(1) Government', D9: 'R0020', E9: 1500.25, F9: '1,200.50',
      D10: 'R0030', E10: 0.1 + 0.2,
      A20: 'ADD1', E23: 'C0010', D24: 'R0010', E24: 75
    },
    FRP_6: {
      A1: 'FRP_6', A4: 'MAIN', E8: 'C0010', G8: 'C0030', D10: 'R0010',
      A55: 'MAIN_1A1C', E59: 'C0010', F59: 'C0020', G59: 'C0030',
      C60: '119001000000111300', E60: 'ABC Corp', F60: 1, G60: 1000,
      E61: 'XYZ Inc', G61: 2500.5,
      G62: 9,
      A93: 'ADD1', E96: 'C0020'
    },
    FRP_15B: {
      A1: 'FRP_15B', A4: 'RESIDENT_A1A', E8: 'C0010', I8: 'C0050', K8: 'C0070', M8: 'C0090',
      E9: 'Sub One', I9: 'Agriculture, Forestry and Fishing [5]', K9: 43968, M9: 'Voting [1]'
    },
    MICRO_MIS: { A1: 'MICRO_MIS', A4: 'NoFieldStaff', A5: 'Number of field staff', A6: 12, A12: 'MAIN', E14: 'C0010', D17: 'R0030', E17: 100 },
    FRPTI_D1: { A1: 'FRPTI_D1', A4: 'MAIN_X1', D8: 'FCLASS', D9: 'FNAME', D10: 'R0010', E8: 'Bond Fund [2]', E9: 'Fund A', E10: 500, F8: 1, F9: 'Fund B', F10: 20 },
    FRPTI_D2: { A1: 'FRPTI_D2', A4: 'MAIN_X1', E8: 'C0010', F8: 'C0020', D9: 'FCLASS', D10: 'FNAME', D11: 'R0010', E9: 'Equity Fund [4]', E10: 'Fund U', E11: 10, F11: 560 },
    notes: { A1: 'scratch' }
  };
}

test('template: grids, lists, fields and code lists are read from the sheet layout', async () => {
  const doc = await TEMPLATE.read(fx.makeXlsx(templateBook()), spec, { Undertaking: 'RB0001', Year: 2026, Period: 3 });
  assert.strictEqual(doc.source, 'xlsx');
  assert.strictEqual(doc.header.Period.v, 3);
  const main = doc.forms.FRP_1[0].tables.MAIN.cells;
  assert.strictEqual(main.R0020C0010.v, 1500.25);
  assert.strictEqual(main.R0020C0010.loc, 'FRP_1!E9');
  assert.strictEqual(main.R0030C0010.raw, '0.3', 'floating-point dust is dropped');
  assert.ok(main.R0020C0020.bad);
  assert.strictEqual(doc.forms.FRP_1[0].tables.ADD1.cells.R0010C0010.v, 75);
  const msgs = doc.findings.map((f) => f.code + ' ' + f.msg);
  const expect = (re) => assert.ok(msgs.some((m) => re.test(m)), String(re) + '\n' + msgs.join('\n'));
  expect(/TPL-NOT-INPUT FRP_1 \/ MAIN \/ R0010C0080 \(FRP_1!L8\)/);
  expect(/XSD-TYPE FRP_1 \/ MAIN \/ R0020C0020 \(FRP_1!F9\): "1,200.50" has a comma/);
  const list = doc.forms.FRP_6[0].tables.MAIN_1A1C.items;
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(Object.keys(list[0].cells), ['C0010', 'C0030'], 'the sequence number column is not reported');
  expect(/XSD-REQUIRED FRP_6 \/ MAIN_1A1C entry 3 \(FRP_6!row 62\) has no C0010/);
  const sub = doc.forms.FRP_15B[0].tables.RESIDENT_A1A.items[0].cells;
  assert.strictEqual(sub.C0050.v, '5');
  assert.strictEqual(sub.C0070.v, '2020-05-17');
  assert.strictEqual(sub.C0090.v, '1');
  assert.strictEqual(doc.forms.MICRO_MIS[0].fields.NoFieldStaff.v, 12);
  const funds = doc.forms.FRPTI_D1[0].tables.MAIN_X1.items;
  assert.deepStrictEqual(funds.map((i) => [i.cells.FCLASS.v, i.cells.FNAME.v, i.cells.R0010.v]), [['2', 'Fund A', 500], ['1', 'Fund B', 20]]);
  const usd = doc.forms.FRPTI_D2[0].tables.MAIN_X1.items[0].cells;
  assert.strictEqual(usd.R0010C0010.v, 10);
  assert.strictEqual(usd.R0010C0020.v, 560);
  assert.ok(!doc.forms.notes);

  const r = ENGINE.check(spec, doc, { profile: fx.RB });
  assert.strictEqual(r.evaluator.valueOf('FRPTI_D1', 'MAIN', 'R0010C0020'), 500);
  const req = r.findings.find((f) => f.code === 'REQ-FRP_BS-1');
  assert.ok(req && req.sev === 'warning' && /empty sheet/.test(req.note), 'an empty sheet is only a warning');
});

test('template: compressed workbooks, missing header, wrong workbook', async () => {
  let doc = await TEMPLATE.read(fx.makeXlsx(templateBook(), true), spec, { Undertaking: '', Year: 2026, Period: 3 });
  assert.strictEqual(doc.forms.FRP_1[0].tables.MAIN.cells.R0020C0010.v, 1500.25);
  assert.ok(doc.findings.some((f) => f.code === 'XSD-HEADER' && /Undertaking/.test(f.msg)));
  doc = await TEMPLATE.read(fx.makeXlsx({ Sheet1: { A1: 'hello' } }), spec, { Undertaking: 'X', Year: 2026, Period: 3 });
  assert.ok(doc.fatal && doc.findings.some((f) => f.code === 'TPL-NO-SHEETS'));
  await assert.rejects(() => TEMPLATE.read(new Uint8Array([1, 2, 3, 4]), spec, {}), /not an Excel/);
});

test('template: numbers become the text the XML would carry', () => {
  const type = (n) => spec.types.find((t) => t.n === n);
  assert.strictEqual(TEMPLATE.toRaw(1234.5600000000001, type('Ptype_amount')), '1234.56');
  assert.strictEqual(TEMPLATE.toRaw(1234.567, type('Ptype_amount')), '1234.567');
  assert.strictEqual(TEMPLATE.toRaw(1e-9, type('Ptype_amount')), '0');
  assert.strictEqual(TEMPLATE.toRaw(12, type('Ptype_number_of9')), '12');
  assert.strictEqual(TEMPLATE.toRaw('Common [2]', type('EnumList_CLASS_STOCK_3')), '2');
  assert.strictEqual(TEMPLATE.toRaw('2020/05/17', spec.types.find((t) => t.b === 'D')), '2020-05-17');
});

// ---- repository hygiene --------------------------------------------------------

test('source files are plain ASCII (no invisible characters)', () => {
  const root = path.join(__dirname, '..');
  for (const dir of ['src', 'test', 'tools', '.']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!/\.(js|css|html|py)$/.test(name) || (dir === '.' && name === 'index.html')) continue;
      const bytes = fs.readFileSync(path.join(root, dir, name));
      const at = bytes.findIndex((b) => b > 126 || (b < 32 && b !== 10 && b !== 13 && b !== 9));
      assert.strictEqual(at, -1, `${dir}/${name} has a non-ASCII byte at offset ${at}`);
    }
  }
});

test('index.html is the current build of src/', () => {
  const root = path.join(__dirname, '..');
  const read = (name) => fs.readFileSync(path.join(root, 'src', name), 'utf8');
  let html = read('index.html');
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/, (_, file) => `<style>\n${read(file)}</style>`);
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, file) => `<script>\n${read(file).replace(/<\/script/gi, '<\\/script')}</script>`);
  assert.ok(fs.readFileSync(path.join(root, 'index.html'), 'utf8') === html, 'run: node tools/build.js');
});

(async () => {
  spec = await SPEC.load();
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   ' + name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + String(e && e.stack ? e.stack : e).split('\n').slice(0, 6).join('\n     '));
    }
  }
  console.log(`\n${tests.length - failed} of ${tests.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
