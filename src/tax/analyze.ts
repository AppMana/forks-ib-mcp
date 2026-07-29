import {
  type DateOnly,
  addCalendarDays,
  classifyHoldingPeriod,
  compareDateOnly,
  isInsideWashSaleWindow,
} from "./us-irs.js";

export type TaxAccountKind = "TAXABLE" | "IRA" | "ROTH_IRA" | "UNKNOWN";

export interface TaxAcquisition {
  id: string;
  accountId: string;
  accountKind: TaxAccountKind;
  conid: number;
  acquiredOn: DateOnly;
  quantity: number;
  unitCost: number;
  proposed?: boolean;
}

export interface TaxLotMatch {
  acquisitionId: string;
  accountId: string;
  accountKind: TaxAccountKind;
  conid: number;
  acquiredOn: DateOnly;
  quantity: number;
  unitBasis: number;
  unitProceeds: number;
  gainLoss: number;
  holdingPeriod: "SHORT_TERM" | "LONG_TERM";
}

export interface TaxDisposition {
  id: string;
  accountId: string;
  conid: number;
  disposedOn: DateOnly;
  quantity: number;
  unitProceeds: number;
  matches: TaxLotMatch[];
  proposed?: boolean;
}

export interface OpenTaxLot extends TaxAcquisition {
  remainingQuantity: number;
}

export interface WashSaleAdjustment {
  lossDispositionId: string;
  sourceAcquisitionId: string;
  lossAccountId: string;
  lossConid: number;
  disposedOn: DateOnly;
  replacementAcquisitionId: string;
  replacementAccountId: string;
  replacementAccountKind: TaxAccountKind;
  replacementConid: number;
  replacementAcquiredOn: DateOnly;
  matchedQuantity: number;
  disallowedLoss: number;
  basisAdjustmentAllowed: boolean;
  replacementBasisIncrease: number;
  adjustedReplacementUnitBasis: number | null;
  holdingPeriodCarriesFrom: DateOnly | null;
  permanentIraDisallowance: boolean;
}

export interface WashSaleAnalysis {
  adjustments: WashSaleAdjustment[];
  totalDisallowedLoss: number;
  matchedReplacementQuantity: number;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

export function matchWashSales(
  dispositions: TaxDisposition[],
  acquisitions: TaxAcquisition[],
  substantiallyIdenticalConids: ReadonlySet<number>,
): WashSaleAnalysis {
  const remainingByAcquisition = new Map(
    acquisitions.map((acquisition) => [acquisition.id, acquisition.quantity]),
  );
  const orderedAcquisitions = [...acquisitions].sort((left, right) => {
    const dateOrder = compareDateOnly(left.acquiredOn, right.acquiredOn);
    return dateOrder || left.id.localeCompare(right.id);
  });
  const lossBlocks = dispositions
    .flatMap((disposition) =>
      disposition.matches
        .filter((match) => match.gainLoss < 0)
        .map((match) => ({ disposition, match }))
    )
    .sort((left, right) => {
      const dateOrder = compareDateOnly(left.disposition.disposedOn, right.disposition.disposedOn);
      if (dateOrder) return dateOrder;
      return left.match.acquiredOn.localeCompare(right.match.acquiredOn);
    });

  const adjustments: WashSaleAdjustment[] = [];
  for (const { disposition, match } of lossBlocks) {
    let unmatchedLossQuantity = match.quantity;
    const lossPerShare = Math.abs(match.gainLoss) / match.quantity;

    for (const acquisition of orderedAcquisitions) {
      if (unmatchedLossQuantity <= 0) break;
      if (!substantiallyIdenticalConids.has(disposition.conid)) continue;
      if (!substantiallyIdenticalConids.has(acquisition.conid)) continue;
      if (acquisition.id === match.acquisitionId) continue;
      if (!isInsideWashSaleWindow(disposition.disposedOn, acquisition.acquiredOn)) continue;

      const available = remainingByAcquisition.get(acquisition.id) ?? 0;
      if (available <= 0) continue;
      const matchedQuantity = Math.min(unmatchedLossQuantity, available);
      const disallowedLoss = roundMoney(matchedQuantity * lossPerShare);
      const iraReplacement = acquisition.accountKind === "IRA"
        || acquisition.accountKind === "ROTH_IRA";

      adjustments.push({
        lossDispositionId: disposition.id,
        sourceAcquisitionId: match.acquisitionId,
        lossAccountId: disposition.accountId,
        lossConid: disposition.conid,
        disposedOn: disposition.disposedOn,
        replacementAcquisitionId: acquisition.id,
        replacementAccountId: acquisition.accountId,
        replacementAccountKind: acquisition.accountKind,
        replacementConid: acquisition.conid,
        replacementAcquiredOn: acquisition.acquiredOn,
        matchedQuantity,
        disallowedLoss,
        basisAdjustmentAllowed: !iraReplacement,
        replacementBasisIncrease: iraReplacement ? 0 : disallowedLoss,
        adjustedReplacementUnitBasis: iraReplacement
          ? null
          : roundMoney(acquisition.unitCost + disallowedLoss / matchedQuantity),
        holdingPeriodCarriesFrom: iraReplacement ? null : match.acquiredOn,
        permanentIraDisallowance: iraReplacement,
      });
      remainingByAcquisition.set(acquisition.id, available - matchedQuantity);
      unmatchedLossQuantity -= matchedQuantity;
    }
  }

  return {
    adjustments,
    totalDisallowedLoss: roundMoney(
      adjustments.reduce((total, adjustment) => total + adjustment.disallowedLoss, 0),
    ),
    matchedReplacementQuantity: adjustments.reduce(
      (total, adjustment) => total + adjustment.matchedQuantity,
      0,
    ),
  };
}

export function analyzeProposedBuy(input: {
  accountId: string;
  accountKind: TaxAccountKind;
  conid: number;
  quantity: number;
  tradeDate: DateOnly;
  dispositions: TaxDisposition[];
  acquisitions: TaxAcquisition[];
  substantiallyIdenticalConids: ReadonlySet<number>;
}): {
  action: "BUY";
  proposedAcquisition: TaxAcquisition;
  washSale: WashSaleAnalysis;
  warning: string | null;
} {
  assertPositive(input.quantity, "Buy quantity");
  const proposedAcquisition: TaxAcquisition = {
    id: "PROPOSED-BUY",
    accountId: input.accountId,
    accountKind: input.accountKind,
    conid: input.conid,
    acquiredOn: input.tradeDate,
    quantity: input.quantity,
    unitCost: 0,
    proposed: true,
  };
  const allAcquisitions = [...input.acquisitions, proposedAcquisition];
  const allWashSales = matchWashSales(
    input.dispositions,
    allAcquisitions,
    input.substantiallyIdenticalConids,
  );
  const proposedAdjustments = allWashSales.adjustments.filter(
    (adjustment) => adjustment.replacementAcquisitionId === proposedAcquisition.id,
  );
  const washSale: WashSaleAnalysis = {
    adjustments: proposedAdjustments,
    totalDisallowedLoss: roundMoney(
      proposedAdjustments.reduce((total, adjustment) => total + adjustment.disallowedLoss, 0),
    ),
    matchedReplacementQuantity: proposedAdjustments.reduce(
      (total, adjustment) => total + adjustment.matchedQuantity,
      0,
    ),
  };

  return {
    action: "BUY",
    proposedAcquisition,
    washSale,
    warning: washSale.adjustments.length === 0
      ? null
      : `Proposed buy would replace ${washSale.matchedReplacementQuantity} loss-sale shares and disallow an estimated $${washSale.totalDisallowedLoss.toFixed(2)} loss.`,
  };
}

export function analyzeProposedSale(input: {
  accountId: string;
  conid: number;
  quantity: number;
  unitProceeds: number;
  tradeDate: DateOnly;
  openLots: OpenTaxLot[];
  acquisitions: TaxAcquisition[];
  dispositions: TaxDisposition[];
  substantiallyIdenticalConids: ReadonlySet<number>;
  lotMethod: "FIFO" | "LONG_TERM_FIRST";
}): {
  action: "SELL";
  disposition: TaxDisposition;
  proceeds: number;
  costBasis: number;
  gainLoss: number;
  shortTermGainLoss: number;
  longTermGainLoss: number;
  insufficientQuantity: number;
  knownWashSale: WashSaleAnalysis;
  futureWashSaleRiskUntil: DateOnly | null;
} {
  assertPositive(input.quantity, "Sale quantity");
  assertPositive(input.unitProceeds, "Sale unit proceeds");
  const lots = input.openLots
    .filter((lot) => lot.accountId === input.accountId && lot.conid === input.conid)
    .map((lot) => ({ ...lot }))
    .sort((left, right) => {
      if (input.lotMethod === "LONG_TERM_FIRST") {
        const leftLong = classifyHoldingPeriod(left.acquiredOn, input.tradeDate) === "LONG_TERM";
        const rightLong = classifyHoldingPeriod(right.acquiredOn, input.tradeDate) === "LONG_TERM";
        if (leftLong !== rightLong) return leftLong ? -1 : 1;
      }
      const dateOrder = compareDateOnly(left.acquiredOn, right.acquiredOn);
      return dateOrder || left.id.localeCompare(right.id);
    });

  let remaining = input.quantity;
  const matches: TaxLotMatch[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const quantity = Math.min(remaining, lot.remainingQuantity);
    if (quantity <= 0) continue;
    const gainLoss = roundMoney(quantity * (input.unitProceeds - lot.unitCost));
    matches.push({
      acquisitionId: lot.id,
      accountId: lot.accountId,
      accountKind: lot.accountKind,
      conid: lot.conid,
      acquiredOn: lot.acquiredOn,
      quantity,
      unitBasis: lot.unitCost,
      unitProceeds: input.unitProceeds,
      gainLoss,
      holdingPeriod: classifyHoldingPeriod(lot.acquiredOn, input.tradeDate),
    });
    remaining -= quantity;
  }

  const disposition: TaxDisposition = {
    id: "PROPOSED-SELL",
    accountId: input.accountId,
    conid: input.conid,
    disposedOn: input.tradeDate,
    quantity: input.quantity - remaining,
    unitProceeds: input.unitProceeds,
    matches,
    proposed: true,
  };
  const knownWashSaleAll = matchWashSales(
    [...input.dispositions, disposition],
    input.acquisitions,
    input.substantiallyIdenticalConids,
  );
  const knownAdjustments = knownWashSaleAll.adjustments.filter(
    (adjustment) => adjustment.lossDispositionId === disposition.id,
  );
  const knownWashSale: WashSaleAnalysis = {
    adjustments: knownAdjustments,
    totalDisallowedLoss: roundMoney(
      knownAdjustments.reduce((total, adjustment) => total + adjustment.disallowedLoss, 0),
    ),
    matchedReplacementQuantity: knownAdjustments.reduce(
      (total, adjustment) => total + adjustment.matchedQuantity,
      0,
    ),
  };
  const gainLoss = roundMoney(matches.reduce((total, match) => total + match.gainLoss, 0));

  return {
    action: "SELL",
    disposition,
    proceeds: roundMoney(disposition.quantity * input.unitProceeds),
    costBasis: roundMoney(
      matches.reduce((total, match) => total + match.quantity * match.unitBasis, 0),
    ),
    gainLoss,
    shortTermGainLoss: roundMoney(
      matches
        .filter((match) => match.holdingPeriod === "SHORT_TERM")
        .reduce((total, match) => total + match.gainLoss, 0),
    ),
    longTermGainLoss: roundMoney(
      matches
        .filter((match) => match.holdingPeriod === "LONG_TERM")
        .reduce((total, match) => total + match.gainLoss, 0),
    ),
    insufficientQuantity: remaining,
    knownWashSale,
    futureWashSaleRiskUntil: gainLoss < 0 ? addCalendarDays(input.tradeDate, 30) : null,
  };
}
