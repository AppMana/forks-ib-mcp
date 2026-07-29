# Tax analysis design

The MCP's tax output is a pre-trade risk analysis, not a tax return or a
substitute for IBKR's authoritative tax-lot records.

## Primary rules

The versioned `US-IRS-PUB550-2025` entry in `src/tax/us-irs.ts` maps these
primary sources:

- [IRS Publication 550 (2025)](https://www.irs.gov/publications/p550)
- [26 CFR 1.1091-1](https://www.ecfr.gov/current/title-26/section-1.1091-1)

The implementation translates the following details directly:

- A security's acquisition trade date is excluded and disposition trade date is
  included. Exactly one year is short-term; long-term requires more than one
  year.
- The wash-sale period starts 30 calendar days before the loss disposition and
  ends 30 calendar days after it. Both endpoints are included, making 61
  possible calendar dates.
- Only loss blocks are adjusted. Replacement shares are matched in acquisition
  order and can create a partial disallowance.
- A taxable replacement lot receives the disallowed loss as a basis increase
  and carries the old holding period. A replacement purchase in an IRA or Roth
  IRA creates a permanent disallowance without an IRA basis increase.

The tests in `test/us-irs-tax.test.ts` include day −30/day +30, day −31/day
+31, exactly-one-year, leap-day, partial-share, acquisition-order, and IRA
boundaries.

## IBKR evidence and confidence

`analyze_tax_trade` retrieves `/pa/transactions`, preserves optional raw output,
and reconstructs FIFO lots. On a proposed sale it compares the reconstructed
open quantity with `/portfolio/{accountId}/positions`.

PortfolioAnalyst transaction history is not an authoritative open-tax-lot
report. A mismatch, missing acquisition, transfer, corporate action, inherited
basis, historical broker adjustment, or prior wash-sale adjustment makes the
result `UNVERIFIED`. An IBKR Flex tax-lot report is still required before a
strict `LTCG_ONLY` submission gate can be trustworthy.

The IRS "substantially identical" determination is facts-and-circumstances.
The MCP never treats two different contract IDs as related unless the caller
supplies them in `relatedConids`. Similarly, advisor accounts may belong to
different taxpayers, so only explicitly supplied `relatedAccountIds` are
combined.

## Existing code reviewed

The implementation is original, but the following repositories were reviewed
for prior art:

- [Google wash-sale-calculator](https://github.com/adlr/wash-sale-calculator):
  BSD-licensed lot splitting, chronological replacement matching, and
  Publication 550 example fixtures.
- [nkouevda/capital-gains](https://github.com/nkouevda/capital-gains):
  MIT-licensed FIFO lot splitting and partial wash-sale allocation.
- [dTaxLab/dtax](https://github.com/dTaxLab/dtax):
  UTC calendar-day boundary tests and explicit simulation output. Its AGPL code
  was not copied, and its holding-period behavior was checked independently
  against Publication 550's stricter "more than one year" wording.

The repositories are test-pattern references only; IRS and Treasury sources
control when an implementation differs.
