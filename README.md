# BSP Reports Validator

Pre-checks a report submission before it goes to the Bangko Sentral ng Pilipinas.
It reads the file on your own computer and reports what the BSP's validation would object to, using the BSP's own rule codes.

| Report | Version | BSP name |
| --- | --- | --- |
| `FRP_S` | 15.0 | Simplified FRP and FRP Related Reports |
| `WRR_RCB` | 1.0 | Weekly Reserves Report for Rural and Cooperative Banks |

Open `index.html` in a current Chrome, Edge or Firefox, or use https://elvinsanity98.github.io/bsp-reports-validator/.
It is one self-contained file: no installation, nothing uploaded. Once loaded it works without internet.

Unofficial helper, not affiliated with the BSP. A file that passes here can still be rejected.

## What it reads

The tool recognises which report a file is, from the root element of the XML or the sheet names of the workbook.

| File | Notes |
| --- | --- |
| `.xml` | The submission file that follows the report's XSD. Findings point at the line in the file. |
| `.zip` | A zip that holds exactly one such `.xml`. |
| `.xlsx` | The BSP input template for the report, filled in. Findings point at the sheet and cell. The template has no place for the bank code and the reporting period, so enter them on the page. |

## What it checks

1. **File and schema** (`XML-`, `XSD-`): well-formed XML, the right namespace, a complete Header, every schedule the schema requires
   and only schedules, tables and cells it knows, no totals that the BSP calculates itself, and every value in the right format
   (amounts with at most 2 decimals and no commas, whole numbers, code lists, dates, text lengths). The BSP reports these as `XSD-0001`.
2. **Conditional cells** (`COND-0001`): a value in a cell whose condition is false, for example a column the report does not use
   or a line meant for another type of bank. The BSP rejects it with the same code.
3. **The BSP's rules**: every rule of the specification's "Assertions" sheet (13,180 for FRP_S, 5 for WRR_RCB).
   - `REQ-` schedules that must, or must not, be submitted for the period and bank type
   - `STG1-` checks on single cells and groups of cells
   - `RIN-` reconciliations inside a schedule and between schedules, each with its tolerance
   - `XREQ-` branch coverage in the BRIS schedules
4. **Sanity checks of this tool** (`CHECK-`): not BSP rules, always warnings. At present: a weekly report whose dates do not run Friday to Thursday.

Before the rules run, the tool works out the totals the BSP calculates (the grey cells of the template), because most rules compare those totals.
The **Schedules** tab shows every schedule the way the BSP will see it: your figures plus those totals.

Click a finding to see both sides of the rule, the cells each side reads, their values, the tolerance and the difference.

### Decimals left behind by Excel

A cell that shows `98,358,232.84` can hold `98358232.8399999`. The BSP rejects that value. The tool reads workbook numbers to
15 significant digits, the way Excel does, so binary noise such as `0.30000000000000004` is ignored but a value like the one
above is reported, with its cell, so it can be rounded.

## Bank profile

Some rules depend on facts the BSP holds about the bank. Set them under **Bank profile**; the page remembers them and only asks for what the chosen report uses.

- Bank type (RB, TB, UKB, DB) and, for a bank subsidiary, the parent's type
- Trust authority, e-money issuer, domestic bank
- Number of banking offices (used by "all branches need to be reported")
- Branch list, one office per line: `branch code, region code, location code` (used by the BRIS regional totals)

A rule or conditional cell that needs a fact left blank is counted as **not checked**. It never produces a finding.

## Earlier periods

About 50 FRP_S rules compare the period with an earlier one (last month, last quarter, last year, the last three year-ends).
Add those submissions under **Earlier periods** and the rules run. Without them they are counted as not checked.

## Command line

Needs Node.js 18 or later.

```
node cli.js <file.xml | file.zip | template.xlsx> [options]

  --bank RB|TB|UKB|DB      bank type
  --parent UKB|DB|TB|RB    parent bank type, for a bank subsidiary
  --offices N              number of banking offices
  --trust  --emi           has trust authority / is an e-money issuer
  --foreign                branch of a foreign bank
  --branches FILE          CSV of: branch code, region code, location code
  --code X                 bank code, for the Excel template only
  --year Y --month M       period of a monthly report, for the Excel template only
  --from DATE --to DATE    period of a weekly report, for the Excel template only (YYYY-MM-DD)
  --report CODE            which report the file is, when the file cannot say
  --prior FILE             an earlier period's XML (repeatable)
  --csv FILE               write the findings to a CSV file
  --all                    list every finding
```

Exit code 0 = no errors, 1 = errors found, 2 = could not run.

```
node cli.js samples/clean/FRP_S_RB0001_2026-03.xml --bank RB --offices 2 --branches samples/branches.csv
node cli.js samples/clean/WRR_RCB_RB0001_2026-09-18.xml --bank RB
node cli.js samples/with-errors/WRR_RCB_RB0001_2026-09-19_errors.xml --bank RB
```

`samples/README.txt` lists the sample files and the profile they assume. All figures in them are made up.

## How far it agrees with the BSP

The tool was compared with the BSP's own processing results for the past submissions of one rural bank. Those files and results are not part of this repository.

**FRP_S**, 38 processing results from October 2023 to August 2026:

- 33 accepted submissions. The tool reports no error on 32 of them. On the remaining one, for the December 2023 period, it reports `RIN-PBS618S`;
  the BSP did not raise that rule on that file but did raise it on the next quarter's, so the rule was most likely added or changed in between.
- 2 rejected submissions whose rejected file was kept. The tool reports the same findings as the BSP, with the same left and right values
  for every failed rule, and the same six badly formatted values on the same lines.
- 3 rejected sandbox attempts whose files were not kept, so nothing could be compared.
- In three older rejected files the BSP raised `COND-0001` on two cells. The tool raises it on the same two cells and no others.

**WRR_RCB**, 12 accepted submissions and 3 rejected sandbox attempts from July to September 2026:

- The tool reports nothing on the 11 accepted files that were kept.
- A file with no Header is rejected by both.
- The values the BSP rejected in the other two attempts (`...8399999` and the like) are found in the workbooks of those weeks and are reported.

This is evidence from one bank that files only a part of the schedules (no trust, e-money, FCDU or foreign-office business).
Rules that this bank's data never exercises are untested against the BSP.

## Limits and assumptions

- **Conditional cells with a zero.** The BSP rejected non-zero values in conditional cells. Whether a reported `0` is also rejected is not known,
  because no past file had one; the tool reports a zero there as a warning.
- **Empty sheets in the Excel template.** A sheet with no values is treated as a schedule that was not submitted,
  and "required schedule not submitted" is then a warning rather than an error.
- **Blank cells count as zero** in every calculation and comparison.
- **Derived schedules** (FRPTI_B, FRPTI_C, FRPTI_D, FRPTI_E1, FRPTI_E2, MLR_I, MSME_MR) are built by the BSP from other schedules.
  They are treated as present when at least one of their source schedules is present.
- **Ratios with a zero base** cannot be worked out; the rules that use them are counted as not checked.
- **Equality** allows for binary floating-point noise only (half a millionth, or 1 part in 10^13 for very large amounts), on top of the rule's own tolerance.
- **Text between elements.** The schema does not allow it, but the BSP accepted a file with a stray character, so it is a warning.
- **Excel template layout.** Lists that run across columns (the fund schedules FRPTI_D1, D2, E1A, E1B) are read one entry per column,
  or per group of coded columns. This follows the blank template; it was not tested against a filled trust return.
- **Rule versions.** The rules are the ones in the specification workbook the tool was built from. The BSP changes rules without changing the version number.

## Adding a report, or moving to a new version

The rules are not written in this repository. They are compiled from the two files the BSP publishes for a report:

```
python tools/build_spec.py "<folder holding REPORT_vN.N.xsd and REPORT_vN.N_specification.xlsx>" --title "<BSP name of the report>"
node tools/build.js
node tools/make_samples.js
node test/run.js
```

`build_spec.py` needs Python 3.8+ and `openpyxl`. It writes `src/spec-<report>.js` and prints a count of anything the schema and the specification disagree on.
For a new report, also add its `<script src="spec-<report>.js">` line to `src/index.html`. The page and the command line pick the report up from there.
The BSP's files themselves are not kept in this repository.

## Development

```
src/spec-<report>.js  compiled report definitions (generated; gzip + base64)
src/spec.js           unpacks and indexes them, recognises a file's report
src/xml.js            XML reader that keeps line numbers
src/formula.js        parser for the BSP formula language
src/engine.js         schema checks, calculated totals, rule evaluation
src/template.js       reads the Excel input template
src/app.js            the page
tools/build.js        bundles src/ into index.html
test/run.js           tests
```

Edit `src/`, then run `node tools/build.js` and `node test/run.js`. Commit the rebuilt `index.html` with the source change.

Developed by Eejay Gimena, IT Head, Rural Bank of Liloy (ZN), Inc.
