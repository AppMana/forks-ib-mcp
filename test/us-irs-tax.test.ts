import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  calendarDaysBetween,
  classifyHoldingPeriod,
  isInsideWashSaleWindow,
  oneYearAnniversary,
  parseDateOnly,
  washSaleWindow,
} from "../src/tax/us-irs.js";
import {
  analyzeProposedBuy,
  analyzeProposedSale,
  matchWashSales,
  type OpenTaxLot,
  type TaxAcquisition,
  type TaxDisposition,
} from "../src/tax/analyze.js";

// These fixtures translate the operative language and examples in IRS Publication
// 550 (2025), not the output of another tax package:
// https://www.irs.gov/publications/p550
describe("US IRS investment-tax calendar rules", () => {
  describe("holding period boundaries", () => {
    it("treats exactly one year as short-term and the following date as long-term", () => {
      // Pub. 550: long-term requires MORE than one year; acquisition day is
      // excluded and disposition day is included.
      expect(classifyHoldingPeriod("2024-01-01", "2025-01-01")).toBe("SHORT_TERM");
      expect(classifyHoldingPeriod("2024-01-01", "2025-01-02")).toBe("LONG_TERM");
    });

    it("uses trade dates and calendar anniversaries rather than 365-day durations", () => {
      expect(calendarDaysBetween("2023-03-01", "2024-03-01")).toBe(366);
      expect(classifyHoldingPeriod("2023-03-01", "2024-03-01")).toBe("SHORT_TERM");
      expect(classifyHoldingPeriod("2023-03-01", "2024-03-02")).toBe("LONG_TERM");
    });

    it("handles a February 29 acquisition without a March 2 off-by-one error", () => {
      expect(oneYearAnniversary("2024-02-29")).toBe("2025-02-28");
      expect(classifyHoldingPeriod("2024-02-29", "2025-02-28")).toBe("SHORT_TERM");
      expect(classifyHoldingPeriod("2024-02-29", "2025-03-01")).toBe("LONG_TERM");
    });

    it("rejects impossible dates and a disposition before acquisition", () => {
      expect(() => parseDateOnly("2025-02-29")).toThrow("Invalid calendar date");
      expect(() => classifyHoldingPeriod("2025-01-02", "2025-01-01")).toThrow(
        "precedes acquisition",
      );
    });
  });

  describe("wash-sale 61-day window", () => {
    const saleDate = "2026-07-29" as const;

    it("includes both dates exactly 30 calendar days away", () => {
      expect(washSaleWindow(saleDate)).toEqual({
        startsOn: "2026-06-29",
        endsOn: "2026-08-28",
      });
      expect(isInsideWashSaleWindow(saleDate, "2026-06-29")).toBe(true);
      expect(isInsideWashSaleWindow(saleDate, "2026-08-28")).toBe(true);
    });

    it("excludes both dates exactly 31 calendar days away", () => {
      expect(isInsideWashSaleWindow(saleDate, "2026-06-28")).toBe(false);
      expect(isInsideWashSaleWindow(saleDate, "2026-08-29")).toBe(false);
    });

    it("does not drift across leap days or daylight-saving changes", () => {
      expect(addCalendarDays("2024-02-01", 30)).toBe("2024-03-02");
      expect(addCalendarDays("2026-03-08", -30)).toBe("2026-02-06");
      expect(calendarDaysBetween("2026-03-08", "2026-04-07")).toBe(30);
    });
  });
});

function acquisition(
  id: string,
  date: TaxAcquisition["acquiredOn"],
  quantity: number,
  unitCost: number,
  accountKind: TaxAcquisition["accountKind"] = "TAXABLE",
): TaxAcquisition {
  return {
    id,
    accountId: accountKind === "TAXABLE" ? "TAXABLE-1" : "IRA-1",
    accountKind,
    conid: 100,
    acquiredOn: date,
    quantity,
    unitCost,
  };
}

function lossDisposition(input: {
  id?: string;
  acquiredOn: TaxAcquisition["acquiredOn"];
  disposedOn: TaxDisposition["disposedOn"];
  quantity: number;
  unitBasis: number;
  unitProceeds: number;
}): TaxDisposition {
  const sourceId = `${input.id ?? "loss"}-source`;
  const gainLoss = input.quantity * (input.unitProceeds - input.unitBasis);
  return {
    id: input.id ?? "loss",
    accountId: "TAXABLE-1",
    conid: 100,
    disposedOn: input.disposedOn,
    quantity: input.quantity,
    unitProceeds: input.unitProceeds,
    matches: [{
      acquisitionId: sourceId,
      accountId: "TAXABLE-1",
      accountKind: "TAXABLE",
      conid: 100,
      acquiredOn: input.acquiredOn,
      quantity: input.quantity,
      unitBasis: input.unitBasis,
      unitProceeds: input.unitProceeds,
      gainLoss,
      holdingPeriod: classifyHoldingPeriod(input.acquiredOn, input.disposedOn),
    }],
  };
}

describe("US IRS wash-sale allocation", () => {
  it("translates Publication 550's 75-of-100-share partial-disallowance example", () => {
    // Pub. 550 example: 100 shares bought for $5,000 and sold for $4,000;
    // 50 + 25 replacement shares were bought in the preceding 30 days.
    const loss = lossDisposition({
      acquiredOn: "2024-09-20",
      disposedOn: "2025-01-03",
      quantity: 100,
      unitBasis: 50,
      unitProceeds: 40,
    });
    const result = matchWashSales(
      [loss],
      [
        acquisition("replacement-50", "2024-12-13", 50, 55),
        acquisition("replacement-25", "2024-12-20", 25, 45),
      ],
      new Set([100]),
    );

    expect(result.matchedReplacementQuantity).toBe(75);
    expect(result.totalDisallowedLoss).toBe(750);
    expect(result.adjustments.map((item) => item.disallowedLoss)).toEqual([500, 250]);
  });

  it("matches replacement shares in acquisition order and does not reuse capacity", () => {
    const firstLoss = lossDisposition({
      id: "first-loss",
      acquiredOn: "2024-01-01",
      disposedOn: "2025-01-03",
      quantity: 60,
      unitBasis: 20,
      unitProceeds: 10,
    });
    const secondLoss = lossDisposition({
      id: "second-loss",
      acquiredOn: "2024-02-01",
      disposedOn: "2025-01-04",
      quantity: 60,
      unitBasis: 20,
      unitProceeds: 10,
    });
    const result = matchWashSales(
      [secondLoss, firstLoss],
      [acquisition("replacement", "2025-01-10", 100, 12)],
      new Set([100]),
    );

    expect(result.adjustments).toHaveLength(2);
    expect(result.adjustments[0]).toMatchObject({
      lossDispositionId: "first-loss",
      matchedQuantity: 60,
    });
    expect(result.adjustments[1]).toMatchObject({
      lossDispositionId: "second-loss",
      matchedQuantity: 40,
    });
  });

  it("never applies wash-sale treatment to a gain block", () => {
    const gain = lossDisposition({
      acquiredOn: "2024-01-01",
      disposedOn: "2025-01-03",
      quantity: 10,
      unitBasis: 10,
      unitProceeds: 20,
    });
    const result = matchWashSales(
      [gain],
      [acquisition("replacement", "2025-01-04", 10, 21)],
      new Set([100]),
    );
    expect(result.adjustments).toEqual([]);
  });

  it("marks an IRA replacement as a permanent disallowance with no basis adjustment", () => {
    const loss = lossDisposition({
      acquiredOn: "2024-01-01",
      disposedOn: "2025-01-03",
      quantity: 10,
      unitBasis: 20,
      unitProceeds: 10,
    });
    const result = matchWashSales(
      [loss],
      [acquisition("ira-replacement", "2025-01-04", 10, 11, "IRA")],
      new Set([100]),
    );
    expect(result.adjustments[0]).toMatchObject({
      disallowedLoss: 100,
      basisAdjustmentAllowed: false,
      replacementBasisIncrease: 0,
      adjustedReplacementUnitBasis: null,
      holdingPeriodCarriesFrom: null,
      permanentIraDisallowance: true,
    });
  });

  it("reports the replacement-lot basis increase and holding-period carryover", () => {
    const loss = lossDisposition({
      acquiredOn: "2024-01-01",
      disposedOn: "2025-01-03",
      quantity: 10,
      unitBasis: 20,
      unitProceeds: 10,
    });
    const result = matchWashSales(
      [loss],
      [acquisition("replacement", "2025-01-04", 10, 11)],
      new Set([100]),
    );
    expect(result.adjustments[0]).toMatchObject({
      replacementBasisIncrease: 100,
      adjustedReplacementUnitBasis: 21,
      holdingPeriodCarriesFrom: "2024-01-01",
      permanentIraDisallowance: false,
    });
  });

  it("reports only the residual wash-sale effect caused by a proposed buy", () => {
    const loss = lossDisposition({
      acquiredOn: "2024-01-01",
      disposedOn: "2025-01-03",
      quantity: 100,
      unitBasis: 20,
      unitProceeds: 10,
    });
    const result = analyzeProposedBuy({
      accountId: "TAXABLE-1",
      accountKind: "TAXABLE",
      conid: 100,
      quantity: 50,
      tradeDate: "2025-01-10",
      dispositions: [loss],
      acquisitions: [acquisition("already-replaced", "2025-01-05", 75, 12)],
      substantiallyIdenticalConids: new Set([100]),
    });
    expect(result.washSale.matchedReplacementQuantity).toBe(25);
    expect(result.washSale.totalDisallowedLoss).toBe(250);
    expect(result.warning).toContain("25 loss-sale shares");
  });

  it("does not infer that a different conid is substantially identical", () => {
    const loss = lossDisposition({
      acquiredOn: "2024-01-01",
      disposedOn: "2025-01-03",
      quantity: 10,
      unitBasis: 20,
      unitProceeds: 10,
    });
    const related = { ...acquisition("other", "2025-01-04", 10, 11), conid: 200 };
    expect(matchWashSales([loss], [related], new Set([100])).adjustments).toEqual([]);
    expect(matchWashSales([loss], [related], new Set([100, 200])).adjustments).toHaveLength(1);
  });
});

describe("proposed sale classification", () => {
  it("splits short- and long-term gain by matched lot", () => {
    const lots: OpenTaxLot[] = [
      { ...acquisition("long", "2024-01-01", 5, 10), remainingQuantity: 5 },
      { ...acquisition("short", "2025-06-01", 5, 30), remainingQuantity: 5 },
    ];
    const result = analyzeProposedSale({
      accountId: "TAXABLE-1",
      conid: 100,
      quantity: 10,
      unitProceeds: 20,
      tradeDate: "2025-07-29",
      openLots: lots,
      acquisitions: lots,
      dispositions: [],
      substantiallyIdenticalConids: new Set([100]),
      lotMethod: "FIFO",
    });
    expect(result.longTermGainLoss).toBe(50);
    expect(result.shortTermGainLoss).toBe(-50);
    expect(result.gainLoss).toBe(0);
  });

  it("leaves the future wash deadline open for a loss sale through day +30", () => {
    const lot = { ...acquisition("loss", "2024-01-01", 10, 20), remainingQuantity: 10 };
    const result = analyzeProposedSale({
      accountId: "TAXABLE-1",
      conid: 100,
      quantity: 10,
      unitProceeds: 10,
      tradeDate: "2025-07-29",
      openLots: [lot],
      acquisitions: [lot],
      dispositions: [],
      substantiallyIdenticalConids: new Set([100]),
      lotMethod: "FIFO",
    });
    expect(result.futureWashSaleRiskUntil).toBe("2025-08-28");
  });
});
