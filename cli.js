#!/usr/bin/env node
// Command-line front end for the validator.
//
//   node cli.js <file.xml | file.zip | template.xlsx> [options]
//
// Bank profile (what the BSP holds about the bank; rules that need a fact
// that is not given are counted as "not checked"):
//   --bank RB|TB|UKB|DB     bank type
//   --parent UKB|DB|TB|RB   type of the parent bank, when it is a bank subsidiary
//   --offices N             number of banking offices (head office and branches)
//   --trust  --emi          has trust authority / is an e-money issuer
//   --foreign               branch of a foreign bank
//   --branches FILE         CSV: branch code, region code, location code (1 NCR, 2 Luzon, 3 Visayas, 4 Mindanao, 5 foreign)
// Excel template only (an XML file carries its own header):
//   --code BANKCODE --year YYYY --month M
// Other:
//   --prior FILE            an earlier period's XML, for period-on-period rules (repeatable)
//   --csv FILE              write the findings to a CSV file
//   --all                   list every finding (default: first 40)
//
// Exit code: 0 = no errors, 1 = errors found, 2 = could not run.
const fs = require('fs');
const path = require('path');
const SPEC = require('./src/spec.js');
const ENGINE = require('./src/engine.js');
const TEMPLATE = require('./src/template.js');

const VALUE_FLAGS = ['--bank', '--parent', '--offices', '--branches', '--code', '--year', '--month', '--prior', '--csv'];

function parseArgs(argv) {
  const o = { prior: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(a + ' needs a value');
      if (a === '--prior') o.prior.push(v); else o[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      o[a.slice(2)] = true;
    } else {
      o.files.push(a);
    }
  }
  return o;
}

async function readDoc(file, spec, o) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (/\.xls[xm]$/i.test(file)) return TEMPLATE.read(bytes, spec, { Undertaking: o.code, Year: o.year, Period: o.month });
  if (/\.zip$/i.test(file)) {
    const zip = TEMPLATE.unzip(bytes);
    const xmls = zip.names.filter((n) => /\.xml$/i.test(n) && !/^__MACOSX\//.test(n));
    if (xmls.length !== 1) throw new Error('The zip should hold exactly one .xml file; it holds ' + xmls.length + '.');
    return ENGINE.readXml(await zip.read(xmls[0]), spec);
  }
  return ENGINE.readXmlBytes(bytes, spec);
}

function place(f) { return f.loc || (f.line !== undefined ? 'line ' + f.line : ''); }

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.files.length !== 1) {
    console.error('Usage: node cli.js <file.xml | file.zip | template.xlsx> [--bank RB] [--offices N] [--branches file.csv] [--prior earlier.xml] [--csv out.csv] [--all]');
    process.exit(2);
  }
  const spec = await SPEC.load();
  const offices = o.offices === undefined ? undefined : Number(o.offices);
  const profile = {
    bank: {
      BNKGRP: o.bank || undefined,
      PARENTBNKGRP: o.bank ? (o.parent || 'NONE') : undefined,
      A_TRUST: o.trust ? 1 : 0, A_EMI: o.emi ? 1 : 0, ISDOMESTIC: o.foreign ? 0 : 1,
      BRANCHCOUNT: offices, DOMESTICBRANCHCOUNT: offices
    },
    branches: null
  };
  if (o.branches) {
    profile.branches = {};
    fs.readFileSync(o.branches, 'utf8').split(/\r?\n/).forEach((line) => {
      const p = line.split(/[,;\t]/).map((s) => s.trim());
      if (p[0] && p[1]) profile.branches[p[0]] = { REGION: p[1], BRISLOC: p[2] || undefined };
    });
  }
  const history = {};
  for (const prior of o.prior) {
    const d = await readDoc(prior, spec, o);
    const y = d.header.Year && d.header.Year.v, p = d.header.Period && d.header.Period.v;
    if (d.fatal || typeof y !== 'number' || typeof p !== 'number') throw new Error('Cannot read the period of ' + prior);
    history[y + '-' + ('0' + p).slice(-2)] = d;
  }

  const file = o.files[0];
  const doc = await readDoc(file, spec, o);
  const r = ENGINE.check(spec, doc, { profile, history });
  const st = r.stats, h = doc.header;
  const show = (x) => (x && !x.bad ? x.v : '(not given)');

  console.log(`File      ${path.basename(file)}  (${doc.source === 'xlsx' ? 'Excel input template' : 'XML'})`);
  console.log(`Report    ${spec.report} version ${spec.version}`);
  console.log(`Header    bank ${show(h.Undertaking)}, year ${show(h.Year)}, period ${show(h.Period)}`);
  console.log(`Schedules ${Object.keys(doc.forms).length} with data`);
  console.log(`Rules     ${st.rules} in the specification: ${st.passed} passed, ${st.failed} failed, ${st.notApplicable} not applicable, ${st.skippedTotal} not checked`);
  Object.keys(st.skippedWhy).forEach((why) => console.log(`            not checked (${why}): ${st.skippedWhy[why]}`));
  console.log(`Result    ${r.counts.error} error(s), ${r.counts.warning} warning(s)`);

  const list = o.all ? r.findings : r.findings.slice(0, 40);
  if (list.length) console.log('');
  for (const f of list) {
    const values = f.kind === 'rule' ? `  [${ENGINE.fmt(f.left)} ${f.op} ${ENGINE.fmt(f.right)}${f.tol ? ', tolerance ' + ENGINE.fmt(f.tol) : ''}]` : '';
    console.log(`${f.sev.toUpperCase().padEnd(7)} ${f.code}${place(f) ? ' (' + place(f) + ')' : ''}: ${f.msg}${values}`);
  }
  if (r.findings.length > list.length) console.log(`... and ${r.findings.length - list.length} more. Use --all or --csv.`);

  if (o.csv) {
    const rows = [['Severity', 'Code', 'Schedule', 'Table', 'Cell', 'Entry', 'Where', 'Message', 'Left', 'Operator', 'Right', 'Difference', 'Tolerance']];
    r.findings.forEach((f) => rows.push([f.sev, f.code, f.form, f.table, f.cell, f.item !== undefined ? f.item + 1 : '', place(f), f.msg,
      f.kind === 'rule' ? ENGINE.fmt(f.left) : '', f.op, f.kind === 'rule' ? ENGINE.fmt(f.right) : '', f.diff, f.kind === 'rule' ? f.tol : '']));
    fs.writeFileSync(o.csv, rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
    console.log(`\nFindings written to ${o.csv}`);
  }
  process.exit(r.counts.error ? 1 : 0);
}

main().catch((e) => { console.error('Could not check the file: ' + e.message); process.exit(2); });
