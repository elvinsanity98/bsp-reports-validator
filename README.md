# BSP Reports Validator

Pre-checks a report submission before it goes to the Bangko Sentral ng Pilipinas.
It reads the file on your own computer and reports what the BSP's validation would object to, using the BSP's own rule codes.

| Report | Version | BSP name |
| --- | --- | --- |
| `AFRD` | 1.0 | AFRD Financing (Mandatory Agriculture, Fisheries and Rural Development Financing) |
| `BCCR` | 1.0 (specification 1.0.1) | Banks' Consolidated Complaints Report |
| `FRP_S` | 15.0 | Simplified FRP and FRP Related Reports |
| `SBLAF` | 1.0 (specification 1.0.2) | Report on Business Loan Applications using SBLAF Templates |
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
| `.xlsx` | The BSP input template for the report, filled in. Findings point at the sheet and cell. The template has no place for the bank code and the reporting period, so enter them on the page. A workbook exported from this tool carries them in its Header sheet. |

## What it checks

1. **File and schema** (`XML-`, `XSD-`): well-formed XML, the right namespace, a complete Header, every schedule the schema requires
   (and every cell, where a table requires all of them, as SBLAF's does)
   and only schedules, tables and cells it knows, no totals that the BSP calculates itself, and every value in the right format
   (amounts with at most 2 decimals and no commas, whole numbers, code lists, dates, text lengths). The BSP reports these as `XSD-0001`.
2. **Conditional cells** (`COND-0001`): a value in a cell whose condition is false, for example a column the report does not use
   or a line meant for another type of bank. The BSP rejects it with the same code in an XML file. When the BSP portal reads
   a filled-in template it leaves such a value out instead (seen in BCCR: "NONE" or 0 typed in a "Specify others" cell),
   so for a template it is a warning, and **Export to XML** leaves it out too and lists what it left out.
3. **The BSP's rules**: every rule of the specification's "Assertions" sheet (13,180 for FRP_S, 150 for SBLAF, 64 for AFRD, 57 for BCCR, 5 for WRR_RCB).
   - `REQ-` schedules that must, or must not, be submitted for the period and bank type
   - `STG1-` checks on single cells and groups of cells
   - `RIN-` reconciliations inside a schedule and between schedules, each with its tolerance
   - `XREQ-` branch coverage in the BRIS schedules
4. **Sanity checks of this tool** (`CHECK-`): not BSP rules, always warnings. At present: a weekly report whose dates do not run Friday to Thursday,
   and a branch-code cell holding an office's name or "null" (see "Branch code of your office" below).

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
- Number of bank subsidiaries that report with the bank (AFRD: decides whether schedule AFRD_D may be sent)
- Branch list, one office per line: `branch code, region code, location code` (used by the BRIS regional totals)
- Branch code of your office (BCCR, and the BRIS schedules of FRP_S). In the portal a branch cell is a dropdown of the bank's
  offices: it shows the office's name and writes its code (`0` for this bank's head office). In the Excel template the same cell
  holds the name, or "null". With the code entered here, a workbook is read the way the portal reads it, and Export to XML
  writes the code. The XML the portal saved for an earlier period shows the code. With the office name entered too, the
  Schedules tab shows the name in those cells and, under Edit values, offers it in a dropdown as the portal does; the file
  still holds the code, so Export to XML and Export to Excel write `0`. Month cells get a dropdown of the months the same way.

A rule or conditional cell that needs a fact left blank is counted as **not checked**. It never produces a finding.

## Earlier periods

About 50 FRP_S rules compare the period with an earlier one (last month, last quarter, last year, the last three year-ends).
In SBLAF, the annual schedule filed with quarter 4 must equal quarters 1 to 4 added up; add the XML files of quarters 1 to 3 for that rule.
Add those submissions under **Earlier periods** and the rules run. Without them they are counted as not checked.

## Command line

Needs Node.js 18 or later.

```
node cli.js <file.xml | file.zip | template.xlsx> [options]

  --bank RB|TB|UKB|DB      bank type
  --parent UKB|DB|TB|RB    parent bank type, for a bank subsidiary
  --offices N              number of banking offices
  --subsidiaries N         number of bank subsidiaries reporting with the bank (AFRD)
  --trust  --emi           has trust authority / is an e-money issuer
  --foreign                branch of a foreign bank
  --branches FILE          CSV of: branch code, region code, location code
  --branch-code CODE       Excel template: the code the portal's branch dropdown writes for your office
  --code X                 bank code, for the Excel template only
  --year Y --month M       period of a monthly report, for the Excel template only (AFRD: --month is the quarter, 1 to 4)
  --from DATE --to DATE    period of a weekly report, for the Excel template only (YYYY-MM-DD)
  --report CODE            which report the file is, when the file cannot say
  --prior FILE             an earlier period's XML (repeatable)
  --csv FILE               write the findings to a CSV file
  --all                    list every finding
  --save-xlsx              write the file as an Excel workbook next to it (see "Editing in Excel")
  --save-xml               write the XML submission file next to it
```

Exit code 0 = no errors, 1 = errors found, 2 = could not run.

```
node cli.js samples/clean/FRP_S_RB0001_2026-03.xml --bank RB --offices 2 --branches samples/branches.csv
node cli.js samples/clean/WRR_RCB_RB0001_2026-09-18.xml --bank RB
node cli.js samples/clean/AFRD_RB0001_2026-2.xml --bank RB --subsidiaries 0
node cli.js samples/with-errors/WRR_RCB_RB0001_2026-09-19_errors.xml --bank RB
node cli.js samples/clean/SBLAF_RB0001_2026-1.xml
node cli.js SBLAF_2026_4_<bank>_<date>.xml --prior SBLAF_2026_1_<bank>_<date>.xml --prior <quarter 2> --prior <quarter 3>
```

`samples/README.txt` lists the sample files and the profile they assume. All figures in them are made up.

## Editing in Excel, and exporting

Every file opened here, XML or workbook, can be exported both ways with **Export to Excel** and **Export to XML** under the results.
So a submission can be corrected in Excel instead of on the portal:

1. Open the XML (for example the one the portal saved, or last period's) and press **Export to Excel**.
2. Edit the workbook in Excel. It is laid out like the BSP input template, one sheet per schedule: type in the white cells only;
   grey cells are totals the BSP works out. Lists have blank rows (or, for lists that run across, blank columns) for new entries.
   The **Header** sheet keeps the bank code and period.
3. Save it and open it here again. It is checked like any template, and the bank code and period come from its Header sheet.
4. Press **Export to XML** for the file to send.

Schedules sent with no data at all (`<BRIS_LDR/>`) are listed under "Filed empty" in the Header sheet; any other sheet left
empty is read as a schedule not submitted. Values the template has no input cell for (totals the BSP works out, cells the schema
does not know) are left out of the workbook, and the export says which.

Small changes can be made on the page itself: **Schedules** tab, tick **Edit values**, and type over a value (Enter moves down,
as in Excel; `1,234.50` is read as 1234.50). The rules run again after each change and the totals follow. List tables get
**Add entry** and a remove button per entry; for an XML file the bank code and period can be changed there too. The changes
stay on the page until exported, and the page warns before closing with changes not exported. On the page opened by
`node submit.js ui`, a changed file cannot be sent until it is exported to XML; the new XML then opens by itself, ready to send.

From the command line, `--save-xlsx` writes the workbook next to the file and `--save-xml` the XML:

```
node cli.js "WRR_RCB_4000000_2026-10-14_15-14-23.xml" --save-xlsx
node cli.js "WRR_RCB_4000000_2026-10-14_16-02-11.xlsx" --save-xml
```

## Making the XML from the Excel template

Open the filled-in input template, enter the bank code and period, and press **Export to XML**. The page saves the XML submission
file, named like the portal's own (`WRR_RCB_<bank>_<date>_<time>.xml`). Opened through `node submit.js ui`, it then opens that XML
straight away, so it can be checked and sent. From the command line:

```
node cli.js "WRR_RCB_v1.0_input_template.xlsx" --code <bank code> --from 2026-10-02 --to 2026-10-08 --save-xml
```

- Only the white input cells are written; totals the BSP works out are left out, as the schema wants.
- An amount that Excel stores with rounding noise (`98358232.8399999` for 98,358,232.84) is written rounded, and the rounding is listed.
  A real extra decimal (`1234.567`) is not rounded: no file is written until it is fixed in the workbook.
- The file written is checked again before you see it.
- Tried on 12 past weeks of WRR_RCB: from each week's template the tool wrote the same cells and values as the XML the BSP accepted that week.

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

The period is written the way the BSP writes it for each report: `2026-03` for FRP_S (a month), `2026-2` for AFRD (a quarter, no leading zero),
`2026-09-18_09-24` for WRR_RCB (a week). A file for a report this tool has no rules for can be sent too; give `--period`, because the file does not say
whether its period is a month or a quarter.

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

**AFRD**, 15 processing results from December 2023 to July 2026:

- 9 accepted submissions filed from July 2024 on: the tool reports nothing on any of them.
- 1 rejected sandbox attempt whose file was kept: the tool reports the same three failed rules as the BSP, with the same values.
- 4 accepted submissions for 2023 periods: the tool reports `REQ-AFRD_D-2` on them (and on the sandbox attempt above). Those files carry
  schedule AFRD_D holding a single zero, which today's rules do not allow for a bank without subsidiaries. The bank's later files leave AFRD_D out.
  Either the rule came later, or the BSP treats such a schedule as not submitted; the published files do not say which.
- 1 rejected sandbox attempt whose file was not kept, so nothing could be compared.
- Values read from three filled Excel templates equal the values in the XML filed for the same quarter (44 of 45 cells; the one difference was edited in between).

**BCCR**, 12 processing results from September 2025 to July 2026:

- 5 accepted submissions: the tool reports nothing on the files sent.
- 6 rejected sandbox attempts whose files were kept. On five, the tool reports the same failed rules as the BSP, with the same values:
  branches without an entry for each month of the quarter (`XREQ-...-BRANCH`, 1 against 3) and, once, `RIN-BCCR40`, `RIN-BCCR50`
  and `RIN-BCCR60` (0 against 34). On the sixth the BSP named six incomplete entries (`XSD-0001`); the tool names the missing cells of the same entries.
- 1 rejected attempt that sent the quarter 1 file as quarter 2 (`XML-0002`, a check of the portal against the period typed when sending).
  The Send panel takes the period from the file, which avoids it.
- 1 accepted sandbox attempt: the tool reports nothing.
- Values read from the five filled templates of the accepted quarters equal the values in the XML filed (570 cells), once the portal's
  two changes are made: the office's name becomes its branch code, and "Specify others" cells with nothing to specify are left out.
- The bank's numbering in its BSP results ends some codes in `-2` (`XREQ-BCCR_PRODUCT-BRANCH-2`); specification 1.0.1 has them without it.

**SBLAF**, 7 processing results from April 2025 to July 2026:

- 6 accepted submissions: the tool reports nothing on any of them.
- 1 rejected sandbox attempt whose file was kept: the BSP named five empty cells of `MAIN` (`XSD-0001`, "Cells ... are missing");
  the tool names the same five, from the XML and from the workbook it was made from.
- With quarters 1 to 3 loaded, the 2025 annual schedule fails `RIN-SBLAF-20` (218 applications in the annual schedule, 214 in the four quarters).
  The BSP accepted that file in January 2026. The tool uses specification 1.0.2, while the bank's templates up to July 2026 are 1.0,
  so the rule was most likely added or tightened since. Expect it at the next quarter 4.
- Values read from the filled Excel templates equal the values in the XML filed for the same quarter (221 cells, 442 with the annual schedule).

This is evidence from one bank that files only a part of the schedules (no trust, e-money, FCDU or foreign-office business).
Rules that this bank's data never exercises are untested against the BSP.

## Limits and assumptions

- **Conditional cells with a zero.** The BSP rejected non-zero values in conditional cells. Whether a reported `0` is also rejected is not known,
  because no past file had one; the tool reports a zero there as a warning.
- **Tolerance on "greater than".** A rule `left > right` with a tolerance passes when left is within the tolerance of right, so
  `LEN(name) > 0` with tolerance 0.1 passes for an empty name (BCCR's "Specify the other channels" rules). Whether the BSP applies
  the tolerance the same way has not been seen in its results.
- **Empty sheets in the Excel template.** A sheet with no values is treated as a schedule that was not submitted,
  and "required schedule not submitted" is then a warning rather than an error. The exception is a schedule the schema itself
  requires in every file (all of AFRD, and WRR): its sheet counts as filed even when nil, because the XML must carry it either way.
- **Workbooks that only look like the template.** The Excel view the BSP sends back and the specification workbook use the same
  sheet names. They are refused (`TPL-LAYOUT`) instead of being read as an empty template.
- **Blank cells count as zero** in every calculation and comparison. Where a table requires every cell (SBLAF), a blank cell is
  also an error of its own, and still counts as zero in the totals.
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
