Sample files for the BSP Reports Validator.

Set the bank profile on the page before opening them:
  Bank type        Rural bank (RB)
  Parent bank      None, or not a bank
  Banking offices  2
  Bank subsidiaries  0
  Domestic bank    ticked; trust authority and e-money issuer not ticked
  Branch list      001, 9, 4
                   002, 9, 4

clean/FRP_S_RB0001_2026-03.xml         FRP quarter-end file, no findings
clean/FRP_S_RB0001_2026-02.xml         FRP monthly file, no findings
clean/WRR_RCB_RB0001_2026-09-18.xml    weekly reserves report, no findings
clean/AFRD_RB0001_2026-2.xml           AFRD financing report for a quarter, no findings (profile: no subsidiaries)
with-errors/FRP_S_RB0001_2026-03_errors.xml       schema errors, a missing schedule, failed reconciliations
with-errors/WRR_RCB_RB0001_2026-09-19_errors.xml  bad amounts, a thrift-bank line, an unnamed "others" line, a wrong week
with-errors/AFRD_RB0001_2026-2_errors.xml         a missing list, a comma, a retired column, totals that do not agree
with-errors/not-well-formed.xml        a closing tag that does not match

All figures are made up. The page recognises which report a file is.

From the command line:
  node cli.js samples/clean/FRP_S_RB0001_2026-03.xml --bank RB --offices 2 --branches samples/branches.csv
  node cli.js samples/clean/WRR_RCB_RB0001_2026-09-18.xml --bank RB
  node cli.js samples/clean/AFRD_RB0001_2026-2.xml --bank RB --subsidiaries 0
