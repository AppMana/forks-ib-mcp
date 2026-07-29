import type {
  OpenTaxLot,
  TaxAccountKind,
  TaxAcquisition,
  TaxDisposition,
  TaxLotMatch,
} from "./analyze.js";
import {
  type DateOnly,
  classifyHoldingPeriod,
  compareDateOnly,
  parseDateOnly,
} from "./us-irs.js";

interface ParsedTransaction {
  index: number;
  accountId: string;
  conid: number;
  date: DateOnly;
  type: string;
  quantity: number;
  unitPrice: number;
  raw: Record<string, unknown>;
}

export interface TransactionHistoryReconstruction {
  accountId: string;
  accountKind: TaxAccountKind;
  conid: number;
  acquisitions: TaxAcquisition[];
  dispositions: TaxDisposition[];
  openLots: OpenTaxLot[];
  warnings: string[];
  provenance: {
    source: "IBKR_PORTFOLIO_ANALYST_TRANSACTIONS";
    authoritativeTaxLots: false;
    rawTransactionCount: number;
    ignoredNonTradeTypes: Record<string, number>;
  };
}

function recordsFromResponse(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const transactions = (data as Record<string, unknown>).transactions;
  return Array.isArray(transactions) ? transactions : [];
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = Number(record[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseTransactions(
  data: unknown,
  accountId: string,
  conid: number,
): {
  transactions: ParsedTransaction[];
  warnings: string[];
  rawCount: number;
  ignoredNonTradeTypes: Record<string, number>;
} {
  const records = recordsFromResponse(data);
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  const ignoredNonTradeTypes: Record<string, number> = {};

  records.forEach((value, index) => {
    if (typeof value !== "object" || value === null) {
      warnings.push(`Ignored transaction ${index}: expected an object`);
      return;
    }
    const record = value as Record<string, unknown>;
    const recordAccount = String(record.acctid ?? record.accountId ?? "").trim();
    const recordConid = numberField(record, "conid");
    if (recordAccount !== accountId || recordConid !== conid) return;

    const type = String(record.type ?? "").trim();
    if (!/^(buy|sell)$/i.test(type)) {
      const label = type || "UNKNOWN";
      ignoredNonTradeTypes[label] = (ignoredNonTradeTypes[label] ?? 0) + 1;
      if (/transfer/i.test(type)) {
        warnings.push(
          `Transaction ${index} (${type}) was preserved in the raw response but not used for lot reconstruction.`,
        );
      }
      return;
    }
    const signedQuantity = numberField(record, "qty", "quantity");
    const unitPrice = numberField(record, "pr", "price");
    if (!record.date || !type || signedQuantity === undefined || unitPrice === undefined) {
      warnings.push(`Ignored transaction ${index}: missing date, type, quantity, or price`);
      return;
    }

    try {
      transactions.push({
        index,
        accountId,
        conid,
        date: parseDateOnly(String(record.date)),
        type,
        quantity: signedQuantity,
        unitPrice,
        raw: record,
      });
    } catch (error) {
      warnings.push(
        `Ignored transaction ${index}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  transactions.sort((left, right) => {
    const dateOrder = compareDateOnly(left.date, right.date);
    return dateOrder || left.index - right.index;
  });
  return {
    transactions,
    warnings,
    rawCount: records.length,
    ignoredNonTradeTypes,
  };
}

function isBuy(transaction: ParsedTransaction): boolean {
  return /^buy$/i.test(transaction.type);
}

function isSell(transaction: ParsedTransaction): boolean {
  return /^sell$/i.test(transaction.type);
}

export function reconstructTransactionHistory(
  data: unknown,
  accountId: string,
  conid: number,
  accountKind: TaxAccountKind = "UNKNOWN",
): TransactionHistoryReconstruction {
  const parsed = parseTransactions(data, accountId, conid);
  const warnings = [...parsed.warnings];
  const acquisitions: TaxAcquisition[] = [];
  const dispositions: TaxDisposition[] = [];
  const openLots: OpenTaxLot[] = [];

  for (const transaction of parsed.transactions) {
    if (isBuy(transaction) && transaction.quantity > 0) {
      const acquisition: TaxAcquisition = {
        id: `${accountId}:${conid}:BUY:${transaction.date}:${transaction.index}`,
        accountId,
        accountKind,
        conid,
        acquiredOn: transaction.date,
        quantity: transaction.quantity,
        unitCost: transaction.unitPrice,
      };
      acquisitions.push(acquisition);
      openLots.push({ ...acquisition, remainingQuantity: acquisition.quantity });
      continue;
    }

    if (isSell(transaction) && transaction.quantity < 0) {
      const sellQuantity = Math.abs(transaction.quantity);
      let remaining = sellQuantity;
      const matches: TaxLotMatch[] = [];
      for (const lot of openLots) {
        if (remaining <= 0) break;
        if (lot.remainingQuantity <= 0) continue;
        const quantity = Math.min(remaining, lot.remainingQuantity);
        matches.push({
          acquisitionId: lot.id,
          accountId,
          accountKind,
          conid,
          acquiredOn: lot.acquiredOn,
          quantity,
          unitBasis: lot.unitCost,
          unitProceeds: transaction.unitPrice,
          gainLoss: Math.round(quantity * (transaction.unitPrice - lot.unitCost) * 100) / 100,
          holdingPeriod: classifyHoldingPeriod(lot.acquiredOn, transaction.date),
        });
        lot.remainingQuantity -= quantity;
        remaining -= quantity;
      }
      if (remaining > 0) {
        warnings.push(
          `Sale on ${transaction.date} has ${remaining} unmatched shares because the requested history does not contain enough prior acquisitions.`,
        );
      }
      dispositions.push({
        id: `${accountId}:${conid}:SELL:${transaction.date}:${transaction.index}`,
        accountId,
        conid,
        disposedOn: transaction.date,
        quantity: sellQuantity,
        unitProceeds: transaction.unitPrice,
        matches,
      });
      continue;
    }

  }

  return {
    accountId,
    accountKind,
    conid,
    acquisitions,
    dispositions,
    openLots: openLots.filter((lot) => lot.remainingQuantity > 0),
    warnings,
    provenance: {
      source: "IBKR_PORTFOLIO_ANALYST_TRANSACTIONS",
      authoritativeTaxLots: false,
      rawTransactionCount: parsed.rawCount,
      ignoredNonTradeTypes: parsed.ignoredNonTradeTypes,
    },
  };
}
