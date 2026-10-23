// Writes the files in samples/. Run: node tools/make_samples.js
// The samples assume the bank profile in samples/README.txt.
const fs = require('fs');
const path = require('path');
const SPEC = require('../src/spec.js');
const fx = require('../test/fixtures.js');

const dir = path.join(__dirname, '..', 'samples');
const write = (name, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  console.log('wrote samples/' + name);
};

// A small bank: one million of cash funded by retained earnings, two offices.
function quarter(spec) {
  const forms = {};
  fx.requiredForms(spec, 3, fx.RB).forEach((f) => { forms[f] = {}; });
  const offices = (a, b) => [Object.assign({ C0030: '001' }, a), Object.assign({ C0030: '002' }, b)];
  forms.FRP_BS = { MAIN: { R0010C0010: '1000000.00', R1680C0010: '1000000.00' } };
  forms.BRIS_BS = { MAIN_Y1: offices({ C0140: '600000.00' }, { C0140: '400000.00' }) };
  forms.BRIS_LES = { MAIN_Y1: offices({ C0090: '600000.00' }, { C0090: '400000.00' }) };
  ['BRIS_AL', 'BRIS_DL', 'BRIS_IR', 'BRIS_REC'].forEach((f) => { forms[f] = { MAIN_Y1: offices() }; });
  forms.CAR15_ONBS_RWA1 = { MAIN: { R0010C0010: '1000000.00', R0380C0010: '1000000.00' } };
  forms.CAR15_TQC1 = { MAIN: { R0060C0030: '1000000.00' } };
  forms.MLR_II = { MAIN: { R0010C0010: '1000000.00' } };
  forms.PBS_Solo = { MAIN1: { R0010C0010: '1000000.00' }, MAIN2: { R0170C0010: '1000000.00' } };
  return forms;
}

function month() {
  return {
    MLR_II: { MAIN: { R0010C0010: '850000.00', R0020C0010: '120000.50', R0100C0010: '300000.00' } },
    MLR_III: { MAIN: { R0010C0010: '2400000.00', R0070C0010: '3100000.00' } },
    MICRO_MBS: {}
  };
}

function broken(spec) {
  const forms = quarter(spec);
  delete forms.FRP_IS;                                           // required schedule left out
  forms.FRP_1 = { MAIN: { R0020C0010: '1,500.00', R0010C0010: '1500.00', R0030C0010: '250.5' } };   // comma; a BSP total
  forms.FRP_2 = { MAIN: { R9999C0010: '10.00' } };               // no such cell
  forms.FRP_BS.MAIN.R0010C0040 = '50.00';                        // FCDU US$ with no peso equivalent
  forms.MLR_II.MAIN.R0010C0010 = '900000.00';                    // does not agree with the balance sheet
  forms.BRIS_BS.MAIN_Y1[1].C0030 = '001';                        // same office twice
  forms.PBS_Solo.MAIN2.R0160C0010 = '-5.00';                     // negative where only positive is allowed
  let xml = fx.buildXml(spec, { period: 3, forms });
  // a schedule that must not be sent in this report
  xml = xml.replace('  <FRP_11B1', '  <FRP_11A234>\n    <FRP_11A234_Item>\n      <Bookcode>1</Bookcode>\n    </FRP_11A234_Item>\n  </FRP_11A234>\n  <FRP_11B1');
  return xml;
}

// Weekly Reserves Report: Friday, Monday to Thursday are typed; the BSP copies
// Friday into Saturday and Sunday.
function week(amounts, others) {
  const cells = {};
  const days = ['C0020', 'C0050', 'C0060', 'C0070', 'C0080'];
  Object.keys(amounts).forEach((row) => days.forEach((col, i) => { cells[row + col] = amounts[row][i]; }));
  Object.assign(cells, others);
  return { WRR: { MAIN: cells } };
}

function wrrClean() {
  return week({
    R0060: ['5200000.50', '5210000.00', '5195000.25', '5180000.00', '5205000.75'],     // savings deposits
    R0100: ['2100000.00', '2100000.00', '2100000.00', '2100000.00', '2100000.00'],     // time deposits
    R0190: ['9800000.84', '9790000.08', '9780000.33', '9730000.54', '9690000.92'],     // total loan portfolio
    R0210: ['480000.26', '455000.00', '462000.10', '470500.00', '468250.40'],          // due from local banks
    R0270: ['15000.00', '15000.00', '15000.00', '15000.00', '15000.00']                // others, line 1
  }, { R0270C0010: 'Dormant accounts' });
}

function wrrBroken(spec) {
  const forms = week({
    R0060: ['5200000.5', '5,210,000.00', '5195000.25', '5180000.00', '5205000.75'],    // a comma
    R0190: ['9800000.8399999', '9790000.08', '9780000.33', '9730000.54', '9690000.92'], // decimals left by a formula
    R0120: ['25000.00', '25000.00', '25000.00', '25000.00', '25000.00'],               // a line for thrift banks only
    R0280: ['4000.00', '4000.00', '4000.00', '4000.00', '4000.00']                     // "others" amount with no name
  }, { R0020C0030: '100.00' });                                                        // Saturday is copied by the BSP
  return fx.buildXml(spec, { from: '2026-09-19', to: '2026-09-24', forms });           // week starts on a Saturday
}

// AFRD: the schema wants every schedule and every list in the file, filled or
// not. A rural bank with no subsidiaries files most of them empty.
function afrdClean(afrd) {
  const forms = fx.skeleton(afrd);
  forms.AFRD_MRA.MAIN = { R0010C0010: '150000000.00', R0010C0030: '120000000.00', R0020C0010: '2000000.00', R0020C0030: '1500000.00' };
  forms.AFRD_A.MAIN_A = { R0010C0010: '9000000.00', R0010C0030: '3000000.00' };
  forms.AFRD_A1.MAIN = { R0010C0010: '120', R0010C0020: '9000000.00', R0020C0030: '40', R0020C0040: '3000000.00' };
  forms.AFRD_B.MAIN = { R0010C0030: '500000.00' };
  forms.AFRD_B3.MAIN_Y1 = [{ C0010: 'Rural Bank of Sample Town', C0030: '500000.00' }];
  return forms;
}

function afrdBroken(afrd) {
  const forms = afrdClean(afrd);
  forms.AFRD_A1.MAIN.R0010C0020 = '8000000.00';                    // the detail no longer adds up to Schedule A
  forms.AFRD_MRA.MAIN.R0010C0020 = '90000000.00';                  // the 2010 base column is not used from 2023 quarter 3
  delete forms.AFRD_A2.MAIN_Y6;                                    // a list the schema requires even when it is empty
  forms.AFRD_B1.MAIN_Y1 = [{ C0010: 'Sample Development Bank', C0040: '1,000,000.00' }];   // a comma in an amount
  forms.AFRD_B2.MAIN_Y1 = [{ C0010: 'Sample Rural Bank', C0030: '1000' }];                 // shares with no acquisition cost
  forms.AFRD_D = { MAIN: { R0110C0010: '0' } };                    // a schedule only for banks with subsidiaries
  return fx.buildXml(afrd, { year: 2026, period: 2, forms });
}

// SBLAF: every cell of MAIN is required, zeros included. Firm size, industry,
// gender, years in operation, loan size and collateral each add up to the same
// totals: 23 applications received, 10 approved secured, 9 approved unsecured,
// 3 rejected, 1 under evaluation, 21,500,000.00 approved.
function sblafMain(sblaf) {
  const table = sblaf.formByName['SBLAF-Q'].tableByName.MAIN;
  const rows = {
    R0010: [20, 8, 9, 2, 1, '9500000.00', '7'], R0020: [3, 2, 0, 1, 0, '12000000.00', '10'], R0030: [0, 0, 0, 0, 0, '0.00', 'NA'],
    R0040: [15, 6, 6, 2, 1, '12000000.00'], R0100: [8, 4, 3, 1, 0, '9500000.00'],
    R0250: [13, 6, 5, 2, 0, '11000000.00'], R0260: [10, 4, 4, 1, 1, '10500000.00'],
    R0270: [5, 2, 2, 1, 0, '4000000.00'], R0280: [10, 4, 4, 1, 1, '9000000.00'], R0290: [8, 4, 3, 1, 0, '8500000.00'],
    R0300: [6, 1, 4, 1, 0, '1000000.00'], R0310: [9, 4, 4, 1, 0, '4500000.00'], R0320: [7, 4, 1, 1, 1, '11000000.00'], R0330: [1, 1, 0, 0, 0, '5000000.00'],
    R0340: [9, 0, null, 0, 0, '3000000.00'], R0350: [10, 7, null, 2, 1, '14500000.00'], R0360: [3, 2, null, 1, 0, '3000000.00'], R0370: [1, 1, null, 0, 0, '1000000.00']
  };
  const cols = ['C0010', 'C0020', 'C0030', 'C0040', 'C0050', 'C0060', 'C0070'];
  const main = {};
  Object.keys(table.c).forEach((code) => {
    const v = (rows[code.slice(0, 5)] || [])[cols.indexOf(code.slice(5))];
    main[code] = v === undefined || v === null ? (code.slice(5) === 'C0060' ? '0.00' : code.slice(5) === 'C0070' ? 'NA' : '0') : String(v);
  });
  return main;
}

function sblafBroken(sblaf) {
  const main = sblafMain(sblaf);
  ['R0340C0010', 'R0340C0020', 'R0340C0040', 'R0340C0050', 'R0340C0060'].forEach((c) => { delete main[c]; });   // left blank, as in a real sandbox run
  main.R0030C0070 = '0';                         // days to process: NA or a whole number from 1
  main.R0020C0060 = '0.00';                      // approved loans with no amount
  main.R0100C0010 = '9';                         // industry no longer adds up to firm size
  return fx.buildXml(sblaf, { year: 2026, period: 4, forms: { 'SBLAF-Q': { MAIN: main } } });   // quarter 4 without the annual schedule
}

// BCCR: one office (branch 001), one entry per month in every schedule, every
// count filled in (zeros included). Each month's complaints are counted the same
// way in every schedule: by product, channel, issue, standard of conduct, sex,
// age, region and status.
function bccrForms(bccr, months, perMonth) {
  const forms = {};
  bccr.forms.forEach((form) => {
    const t = form.tb[0];
    forms[form.n] = { MAIN: months.map((m, i) => {
      const row = {};
      Object.keys(t.c).forEach((c) => {
        const def = t.c[c];
        if (def[0] !== 0) return;
        const type = bccr.types[Array.isArray(def[1]) ? def[1][0] : def[1]];
        if (c === 'C0010') row[c] = String(m);
        else if (c === 'C0030') row[c] = '001';
        else if (type.b === 'd') row[c] = '0';
      });
      const n = String(perMonth[i]);
      ({ BCCR_PRODUCT: ['C0070'], BCCR_CHANNEL: ['C0050'], BCCR_ISSUES: ['C0050'], BCCR_SOC: ['C0060'],
        BCCR_DEMOGRAPHICS: ['C0060', 'C0110', 'C0280'], BCCR_STATUS: ['C0180', 'C0230'], BCCR_BSP_REFERRED: [] })[form.n].forEach((c) => { row[c] = n; });
      return row;
    }) };
  });
  return forms;
}

function bccrBroken(bccr) {
  const forms = bccrForms(bccr, [7, 8, 9], [3, 1, 2]);
  forms.BCCR_SOC.MAIN[2].C0010 = '10';                       // a month outside quarter 3
  forms.BCCR_DEMOGRAPHICS.MAIN[0].C0090 = 'NONE';             // a name for "others" that are not there
  delete forms.BCCR_STATUS.MAIN[2].C0250;                     // a count left blank
  forms.BCCR_ISSUES.MAIN[0].C0050 = '2';                      // issues no longer add up to the products
  return fx.buildXml(bccr, { year: 2026, period: 3, forms });
}

Promise.all([SPEC.load('FRP_S'), SPEC.load('WRR_RCB'), SPEC.load('AFRD'), SPEC.load('SBLAF'), SPEC.load('BCCR')]).then(([spec, wrr, afrd, sblaf, bccr]) => {
  write('clean/BCCR_RB0001_2026-1.xml', fx.buildXml(bccr, { year: 2026, period: 1, forms: bccrForms(bccr, [1, 2, 3], [3, 0, 2]) }));
  write('with-errors/BCCR_RB0001_2026-3_errors.xml', bccrBroken(bccr));
  write('clean/SBLAF_RB0001_2026-1.xml', fx.buildXml(sblaf, { year: 2026, period: 1, forms: { 'SBLAF-Q': { MAIN: sblafMain(sblaf) } } }));
  write('with-errors/SBLAF_RB0001_2026-4_errors.xml', sblafBroken(sblaf));
  write('clean/AFRD_RB0001_2026-2.xml', fx.buildXml(afrd, { year: 2026, period: 2, forms: afrdClean(afrd) }));
  write('with-errors/AFRD_RB0001_2026-2_errors.xml', afrdBroken(afrd));
  write('clean/FRP_S_RB0001_2026-03.xml', fx.buildXml(spec, { period: 3, forms: quarter(spec) }));
  write('clean/FRP_S_RB0001_2026-02.xml', fx.buildXml(spec, { period: 2, forms: month() }));
  write('clean/WRR_RCB_RB0001_2026-09-18.xml', fx.buildXml(wrr, { from: '2026-09-18', to: '2026-09-24', forms: wrrClean() }));
  write('with-errors/FRP_S_RB0001_2026-03_errors.xml', broken(spec));
  write('with-errors/WRR_RCB_RB0001_2026-09-19_errors.xml', wrrBroken(wrr));
  write('with-errors/not-well-formed.xml', fx.buildXml(spec, { period: 2, forms: month() }).replace('</MLR_II>', '</MLR_2>'));
  write('README.txt', [
    'Sample files for the BSP Reports Validator.',
    '',
    'Set the bank profile on the page before opening them:',
    '  Bank type        Rural bank (RB)',
    '  Parent bank      None, or not a bank',
    '  Banking offices  2',
    '  Bank subsidiaries  0',
    '  Domestic bank    ticked; trust authority and e-money issuer not ticked',
    '  Branch list      001, 9, 4',
    '                   002, 9, 4',
    '',
    'clean/FRP_S_RB0001_2026-03.xml         FRP quarter-end file, no findings',
    'clean/FRP_S_RB0001_2026-02.xml         FRP monthly file, no findings',
    'clean/WRR_RCB_RB0001_2026-09-18.xml    weekly reserves report, no findings',
    'clean/AFRD_RB0001_2026-2.xml           AFRD financing report for a quarter, no findings (profile: no subsidiaries)',
    'clean/SBLAF_RB0001_2026-1.xml          SBLAF business loan applications for a quarter, no findings',
    'clean/BCCR_RB0001_2026-1.xml           consumer complaints for a quarter, one office, no findings',
    'with-errors/FRP_S_RB0001_2026-03_errors.xml       schema errors, a missing schedule, failed reconciliations',
    'with-errors/WRR_RCB_RB0001_2026-09-19_errors.xml  bad amounts, a thrift-bank line, an unnamed "others" line, a wrong week',
    'with-errors/AFRD_RB0001_2026-2_errors.xml         a missing list, a comma, a retired column, totals that do not agree',
    'with-errors/SBLAF_RB0001_2026-4_errors.xml        blank cells, a 0 for "NA", an approval with no amount, no annual schedule',
    'with-errors/BCCR_RB0001_2026-3_errors.xml         a month of another quarter, a name for absent "others", a blank count, schedules that disagree',
    'with-errors/not-well-formed.xml        a closing tag that does not match',
    '',
    'All figures are made up. The page recognises which report a file is.',
    '',
    'From the command line:',
    '  node cli.js samples/clean/FRP_S_RB0001_2026-03.xml --bank RB --offices 2 --branches samples/branches.csv',
    '  node cli.js samples/clean/WRR_RCB_RB0001_2026-09-18.xml --bank RB',
    '  node cli.js samples/clean/AFRD_RB0001_2026-2.xml --bank RB --subsidiaries 0',
    '  node cli.js samples/clean/SBLAF_RB0001_2026-1.xml',
    '  node cli.js samples/clean/BCCR_RB0001_2026-1.xml',
    ''
  ].join('\r\n'));
  write('branches.csv', '001,9,4\r\n002,9,4\r\n');
});
