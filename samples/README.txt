Sample files for the BSP Reports Validator.

Set the bank profile on the page before opening them:
  Bank type        Rural bank (RB)
  Parent bank      None, or not a bank
  Banking offices  2
  Domestic bank    ticked; trust authority and e-money issuer not ticked
  Branch list      001, 9, 4
                   002, 9, 4

clean/FRP_S_RB0001_2026-03.xml         quarter-end file, no findings
clean/FRP_S_RB0001_2026-02.xml         monthly file, no findings
with-errors/FRP_S_RB0001_2026-03_errors.xml   schema errors, a missing schedule, failed reconciliations
with-errors/not-well-formed.xml        a closing tag that does not match

From the command line:
  node cli.js samples/clean/FRP_S_RB0001_2026-03.xml --bank RB --offices 2 --branches samples/branches.csv
