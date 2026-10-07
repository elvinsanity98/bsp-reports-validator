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

## Sending a file to the BSP

`submit.js` sends a report through the BSP's machine-to-machine API ("Engine API M2M"), the alternative to uploading it on the submission portal.
It needs Node.js 18 or later on the PC and the bank's client certificate as a `.pfx` file. The hosted page cannot do this: a browser page cannot present the bank's certificate.

| | |
| --- | --- |
| **Sandbox** | The BSP validates the file and returns its findings. Nothing is filed. |
| **Submit** | The real submission. It asks you to type the period before anything is sent. |

### With the page

Double-click `Send-to-BSP.cmd` (or run `node submit.js ui`). The first time it asks where the `.pfx` file is; every time it asks for the certificate's password.
It then opens the validator at `http://127.0.0.1:8777/` with a **Send to the BSP** panel under the results:

1. Open the `.xml` file. It is checked as usual, and report code, bank code and period are filled in from it.
2. **Send to sandbox**. The panel shows the BSP's validation status and offers its result as PDF, XML and Excel.
3. **Submit to the BSP...**, choose the files that go with the report (the signed Control Prooflist PDF, a certification form), type the period,
   **Submit for real**. Nothing is attached by itself: with no file chosen you must tick "Submit without any additional file",
   and if this tool found errors you must tick a box to submit anyway. The sandbox gets the report file alone.

Keep the black window open while you work; closing it stops the page. A list of what was sent from this PC stays under the panel, so a result can be fetched again later.

### From the command line

```
node submit.js setup --pfx "<path to the .pfx>"      one time
node submit.js cert                                  does the BSP accept the certificate?
node submit.js sandbox <file.xml>                    trial run
node submit.js submit  <file.xml>                    real submission, after typing the period
node submit.js status  <token>
node submit.js result  <token> [--kind pdf|xml|json|excel|receipt|all]
node submit.js history

  --attach FILE     a file to file with the report, such as the signed Control Prooflist PDF (repeatable;
                    real submission only, the sandbox takes the report file alone)
  --period P        the period as the BSP writes it: 2026-03 for a month, 2026-09-18_09-24 for a week
  --report CODE  --code BANKCODE    when they cannot be read off the file
  --out DIR         where the BSP's answers are saved (default: next to the file)
  --no-wait         do not wait for the validation
  --force           submit for real although this tool found errors
```

`sandbox` and `submit` wait for the BSP and save its answers next to the file, named like the portal's own:
`SandboxProcessingResult-<bank>-<report>-<period>-<token>.pdf`, `ProcessingResult-...pdf`, `Receipt-...pdf`.
Exit code 0 = accepted as valid, 1 = the BSP found the file invalid, 2 = not sent or could not run.

A file for a report this tool has no rules for can be sent too; give `--period`, because the file does not say whether its period is a month (`2026-03`) or a quarter (`2026-1`).

### What it does with the certificate

- The `.pfx` is read where it is. It is never copied, and `.gitignore` keeps certificate and key files out of this repository.
- The password is asked for on each run and held in memory only. (`BSP_PFX_PASSWORD` in the environment is used instead when set. That suits a scheduled job, but any program running under the same Windows account can read it.)
- The setting file, the list of submissions and downloaded results are kept in `%APPDATA%\bsp-reports-validator`.
- The page server listens on this PC only (`127.0.0.1`), and only the page it handed out can use it: every call carries a key made at start-up, and calls from other sites are refused.
- The BSP's server sends its certificate without the intermediate that signed it. Like a browser, the tool downloads that intermediate from the address named in the certificate; the chain must still end at a root certificate Node already trusts.

### Trying it without the BSP

`node tools/demo-send.js` starts a stand-in server on the PC with throwaway test certificates and opens the page against it. Sandbox and "real" submissions both go to the stand-in. It needs OpenSSL, which Git for Windows includes.

### Not yet proven

The sender follows the BSP's OpenAPI file, Postman collections and implementation guide, and its tests run against the stand-in server.
Against the BSP itself, so far: the certificate check and a sandbox submission were accepted. The BSP answers a submission with the token alone
(a JSON string), not the `{ "token": ... }` object its OpenAPI file describes; the tool reads both.
Still to be seen on real use: the status texts the BSP returns (the tool waits until a result file is available or the status reads `Valid` or `Invalid`,
and the page shows the BSP's raw status answer), the result downloads, a real submission, and the form field name for additional files
(`additionalFiles`, as in the BSP's Postman collection; its OpenAPI file spells it `aditionalFiles`).

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
src/send.js           the page's "Send to the BSP" panel (active only under submit.js ui)
src/bspapi.js         client for the BSP's API (Node only)
submit.js             command line sender and the local page server
tools/build.js        bundles src/ into index.html
test/run.js           tests; test/mock-bsp.js is the stand-in BSP they send to
```

Edit `src/`, then run `node tools/build.js` and `node test/run.js`. Commit the rebuilt `index.html` with the source change.

Developed by Eejay Gimena, IT Head, Rural Bank of Liloy (ZN), Inc.
