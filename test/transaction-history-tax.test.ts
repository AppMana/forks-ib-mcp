import { describe, expect, it } from "vitest";
import { reconstructTransactionHistory } from "../src/tax/transaction-history.js";

describe("IBKR PortfolioAnalyst transaction reconstruction", () => {
  it("parses IBKR's documented date format and reconstructs FIFO lots", () => {
    const raw = {
      transactions: [
        {
          date: "Mon Jan 01 00:00:00 EST 2024",
          pr: 100,
          qty: 10,
          acctid: "U1",
          conid: 265598,
          type: "Buy",
        },
        {
          date: "Wed Jan 10 00:00:00 EST 2024",
          pr: 120,
          qty: 5,
          acctid: "U1",
          conid: 265598,
          type: "Buy",
        },
        {
          date: "Thu Jan 02 00:00:00 EST 2025",
          pr: 110,
          qty: -12,
          acctid: "U1",
          conid: 265598,
          type: "Sell",
        },
      ],
    };
    const result = reconstructTransactionHistory(raw, "U1", 265598, "TAXABLE");

    expect(result.dispositions[0].matches).toEqual([
      expect.objectContaining({
        acquiredOn: "2024-01-01",
        quantity: 10,
        gainLoss: 100,
        holdingPeriod: "LONG_TERM",
      }),
      expect.objectContaining({
        acquiredOn: "2024-01-10",
        quantity: 2,
        gainLoss: -20,
        holdingPeriod: "SHORT_TERM",
      }),
    ]);
    expect(result.openLots).toEqual([
      expect.objectContaining({ acquiredOn: "2024-01-10", remainingQuantity: 3 }),
    ]);
    expect(result.provenance.authoritativeTaxLots).toBe(false);
  });

  it("warns instead of inventing basis when history starts after an acquisition", () => {
    const raw = {
      transactions: [{
        date: "Tue Jul 29 00:00:00 EDT 2025",
        pr: 100,
        qty: -10,
        acctid: "U1",
        conid: 265598,
        type: "Sell",
      }],
    };
    const result = reconstructTransactionHistory(raw, "U1", 265598, "TAXABLE");
    expect(result.dispositions[0].matches).toEqual([]);
    expect(result.warnings[0]).toContain("10 unmatched shares");
  });

  it("keeps transfers out of basis math and reports the limitation", () => {
    const raw = {
      transactions: [{
        date: "20250101",
        pr: 100,
        qty: 10,
        acctid: "U1",
        conid: 265598,
        type: "Transfer",
      }],
    };
    const result = reconstructTransactionHistory(raw, "U1", 265598, "TAXABLE");
    expect(result.openLots).toEqual([]);
    expect(result.warnings[0]).toContain("not used for lot reconstruction");
  });

  it("summarizes normal cash events without calling them malformed trades", () => {
    const raw = {
      transactions: [
        {
          date: "20250131",
          acctid: "U1",
          conid: 265598,
          amt: 125,
          type: "Dividend Payment",
        },
        {
          date: "20250131",
          acctid: "U1",
          conid: 265598,
          amt: 25,
          type: "Payment In Lieu",
        },
      ],
    };
    const result = reconstructTransactionHistory(raw, "U1", 265598, "TAXABLE");

    expect(result.warnings).toEqual([]);
    expect(result.provenance.ignoredNonTradeTypes).toEqual({
      "Dividend Payment": 1,
      "Payment In Lieu": 1,
    });
  });
});
