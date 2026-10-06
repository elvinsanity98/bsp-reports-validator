# BSP Reports Validator

Pre-checks a Financial Reporting Package submission (**FRP_S version 15.0**) before it goes to the Bangko Sentral ng Pilipinas.
It reads the file on your own computer and reports what the BSP's validation would object to, using the BSP's own rule codes.

Open `index.html` in a current Chrome, Edge or Firefox. It is one self-contained file: no installation, no internet, nothing uploaded.

Unofficial helper, not affiliated with the BSP. A file that passes here can still be rejected.

## What it reads

| File | Notes |
| --- | --- |
| `.xml` | The submission file that follows `FRP_S_v15.0.xsd`. Findings point at the line in the file. |
| `.zip` | A zip that holds exactly one such `.xml`. |
| `.xlsx` | The BSP input template (`FRP_S_v15.0_input_template.xlsx`), filled in. Findings point at the sheet and cell. The template has no place for the bank code and period, so enter them on the page. |

## What it checks

1. **File and schema** (`XML-`, `XSD-`): well-formed XML, the right namespace, a complete Header, only schedules, tables and cells
   the schema knows, no totals that the BSP calculates itself, and every value in the right format
   (amounts with at most 2 decimals and no commas, whole numbers, code lists, dates, text lengths).
2. **Cells not used in this report** (`SPEC-NOT-APPLICABLE`): a value in a cell the specification switches off for FRP_S.
3. **The BSP's rules**: all 13,180 rules of the specification's "Assertions" sheet.
   - `REQ-` schedules that must, or must not, be submitted for the period and bank type
   - `STG1-` checks on single cells and pairs of cells
   - `RIN-` reconciliations inside a schedule and between schedules, each with its tolerance
   - `XREQ-` branch coverage in the BRIS schedules

Before the rules run, the tool works out the 31,000 totals the BSP calculates (the grey cells of the template), because most rules compare those totals.
The **Schedules** tab shows every schedule the way the BSP will see it: your figures plus those totals.

Click a finding to see both sides of the rule, the cells each side reads, their values, the tolerance and the difference.

## Bank profile

Some rules depend on facts the BSP holds about the bank. Set them under **Bank profile**; the page remembers them.

- Bank type (RB, TB, UKB, DB) and, for a bank subsidiary, the parent's type
- Trust authority, e-money issuer, domestic bank
- Number of banking offices (used by "all branches need to be reported")
- Branch list, one office per line: `branch code, region code, location code` (used by the BRIS regional totals)

A rule that needs a fact left blank is counted as **not checked**. It never produces a finding.

## Earlier periods

About 50 rules compare the period with an earlier one (last month, last quarter, last year, the last three year-ends).
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
  --code X --year Y --month M    header, for the Excel template only
  --prior FILE             an earlier period's XML (repeatable)
  --csv FILE               write the findings to a CSV file
  --all                    list every finding
```

Exit code 0 = no errors, 1 = errors found, 2 = could not run.

```
node cli.js samples/clean/FRP_S_RB0001_2026-03.xml --bank RB --offices 2 --branches samples/branches.csv
node cli.js samples/with-errors/FRP_S_RB0001_2026-03_errors.xml --bank RB --offices 2 --branches samples/branches.csv
```

`samples/README.txt` lists the sample files and the profile they assume.

## Limits and assumptions

These are places where the published files do not settle the answer. Each is a judgement of this tool, not a statement by the BSP.

- **Cells "not used in this report".** The specification attaches the condition `RCTX("RCODE")<>"FRP_S"` to about 11,400 cells
  (mostly FCDU and foreign-office columns), yet the schema and the template still accept values there.
  The tool reports a value in such a cell as a warning and still includes it in the totals.
- **Empty sheets in the Excel template.** A sheet with no values is treated as a schedule that was not submitted,
  and "required schedule not submitted" is reported as a warning rather than an error.
- **Blank cells count as zero** in every calculation and comparison.
- **Derived schedules** (FRPTI_B, FRPTI_C, FRPTI_D, FRPTI_E1, FRPTI_E2, MLR_I, MSME_MR) are built by the BSP from other schedules.
  They are treated as present when at least one of their source schedules is present.
- **Ratios with a zero base** cannot be worked out; the rules that use them are counted as not checked.
- **Equality** allows for binary floating-point noise only (half a millionth, or 1 part in 10^13 for very large amounts), on top of the rule's own tolerance.
- **Excel template layout.** Lists that run across columns (the fund schedules FRPTI_D1, D2, E1A, E1B) are read one entry per column,
  or per group of coded columns. This follows the blank template; it was not tested against a filled trust return.
- The tool has not been run against the BSP's own validator, so agreement with it is not proven.

## Moving to a new report version

The rules are not written in this repository. They are compiled from the two files the BSP publishes:

```
python tools/build_spec.py "<folder holding FRP_S_vNN.N.xsd and FRP_S_vNN.N_specification.xlsx>"
node tools/build.js
node tools/make_samples.js
node test/run.js
```

`build_spec.py` needs Python 3.8+ and `openpyxl`. It prints a count of anything the schema and the specification disagree on.
The BSP's files themselves are not kept in this repository.

## Development

```
src/spec-data.js   compiled report definition (generated; gzip + base64)
src/spec.js        unpacks and indexes it
src/xml.js         XML reader that keeps line numbers
src/formula.js     parser for the BSP formula language
src/engine.js      schema checks, calculated totals, rule evaluation
src/template.js    reads the Excel input template
src/app.js         the page
tools/build.js     bundles src/ into index.html
test/run.js        tests
```

Edit `src/`, then run `node tools/build.js` and `node test/run.js`. Commit the rebuilt `index.html` with the source change.

Developed by Eejay Gimena, IT Head, Rural Bank of Liloy (ZN), Inc.
