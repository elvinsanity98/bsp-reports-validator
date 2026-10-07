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

Promise.all([SPEC.load('FRP_S'), SPEC.load('WRR_RCB')]).then(([spec, wrr]) => {
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
    '  Domestic bank    ticked; trust authority and e-money issuer not ticked',
    '  Branch list      001, 9, 4',
    '                   002, 9, 4',
    '',
    'clean/FRP_S_RB0001_2026-03.xml         FRP quarter-end file, no findings',
    'clean/FRP_S_RB0001_2026-02.xml         FRP monthly file, no findings',
    'clean/WRR_RCB_RB0001_2026-09-18.xml    weekly reserves report, no findings',
    'with-errors/FRP_S_RB0001_2026-03_errors.xml       schema errors, a missing schedule, failed reconciliations',
    'with-errors/WRR_RCB_RB0001_2026-09-19_errors.xml  bad amounts, a thrift-bank line, an unnamed "others" line, a wrong week',
    'with-errors/not-well-formed.xml        a closing tag that does not match',
    '',
    'All figures are made up. The page recognises which report a file is.',
    '',
    'From the command line:',
    '  node cli.js samples/clean/FRP_S_RB0001_2026-03.xml --bank RB --offices 2 --branches samples/branches.csv',
    '  node cli.js samples/clean/WRR_RCB_RB0001_2026-09-18.xml --bank RB',
    ''
  ].join('\r\n'));
  write('branches.csv', '001,9,4\r\n002,9,4\r\n');
});
