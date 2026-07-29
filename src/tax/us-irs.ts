export type DateOnly = `${number}-${number}-${number}`;

export interface UsIrsRuleSet {
  id: string;
  jurisdiction: "US";
  taxYear: number;
  sources: Array<{
    title: string;
    url: string;
  }>;
  holdingPeriod: {
    acquisitionDateExcluded: true;
    dispositionDateIncluded: true;
    longTermRequires: "MORE_THAN_ONE_YEAR";
    securitiesUse: "TRADE_DATE";
  };
  washSale: {
    lossDispositionsOnly: true;
    lookbackCalendarDays: 30;
    lookforwardCalendarDays: 30;
    endpointsInclusive: true;
    replacementMatching: "ACQUISITION_ORDER";
    includesIraAndRothIraPurchases: true;
  };
}

export const US_IRS_INVESTMENT_RULES_2025: UsIrsRuleSet = {
  id: "US-IRS-PUB550-2025",
  jurisdiction: "US",
  taxYear: 2025,
  sources: [
    {
      title: "IRS Publication 550 (2025), Investment Income and Expenses",
      url: "https://www.irs.gov/publications/p550",
    },
    {
      title: "26 CFR 1.1091-1, Losses from wash sales of stock or securities",
      url: "https://www.ecfr.gov/current/title-26/section-1.1091-1",
    },
  ],
  holdingPeriod: {
    acquisitionDateExcluded: true,
    dispositionDateIncluded: true,
    longTermRequires: "MORE_THAN_ONE_YEAR",
    securitiesUse: "TRADE_DATE",
  },
  washSale: {
    lossDispositionsOnly: true,
    lookbackCalendarDays: 30,
    lookforwardCalendarDays: 30,
    endpointsInclusive: true,
    replacementMatching: "ACQUISITION_ORDER",
    includesIraAndRothIraPurchases: true,
  },
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function makeDateOnly(year: number, month: number, day: number): DateOnly {
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
  ) {
    throw new Error(`Invalid calendar date: ${year}-${month}-${day}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as DateOnly;
}

export function parseDateOnly(value: string): DateOnly {
  const input = value.trim();
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return makeDateOnly(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const compact = input.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return makeDateOnly(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  }

  // PortfolioAnalyst returns values such as "Mon Dec 11 00:00:00 EST 2023".
  // Parse its calendar components rather than constructing a Date in the host timezone.
  const ibkr = input.match(/\b([A-Za-z]{3})\s+(\d{1,2})\b.*\b(\d{4})$/);
  if (ibkr) {
    const month = MONTHS[ibkr[1].toLowerCase()];
    if (month) return makeDateOnly(Number(ibkr[3]), month, Number(ibkr[2]));
  }

  throw new Error(`Unsupported date format: ${value}`);
}

function parts(value: DateOnly): { year: number; month: number; day: number } {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function ordinal(value: DateOnly): number {
  const { year, month, day } = parts(value);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function compareDateOnly(left: DateOnly, right: DateOnly): number {
  return Math.sign(ordinal(left) - ordinal(right));
}

export function addCalendarDays(value: DateOnly, days: number): DateOnly {
  if (!Number.isInteger(days)) throw new Error("Calendar-day offset must be an integer");
  const { year, month, day } = parts(value);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return makeDateOnly(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

export function calendarDaysBetween(start: DateOnly, end: DateOnly): number {
  return ordinal(end) - ordinal(start);
}

export function oneYearAnniversary(acquiredOn: DateOnly): DateOnly {
  const { year, month, day } = parts(acquiredOn);
  // Clamp Feb. 29 to Feb. 28 in a non-leap anniversary year. Because long-term
  // requires strictly MORE than one year, a Feb. 29 lot becomes long-term on
  // March 1 of the following non-leap year, not on Feb. 28 and not on March 2.
  return makeDateOnly(year + 1, month, Math.min(day, daysInMonth(year + 1, month)));
}

export function classifyHoldingPeriod(
  acquiredOn: DateOnly,
  disposedOn: DateOnly,
): "SHORT_TERM" | "LONG_TERM" {
  if (compareDateOnly(disposedOn, acquiredOn) < 0) {
    throw new Error(`Disposition date ${disposedOn} precedes acquisition date ${acquiredOn}`);
  }
  return compareDateOnly(disposedOn, oneYearAnniversary(acquiredOn)) > 0
    ? "LONG_TERM"
    : "SHORT_TERM";
}

export function washSaleWindow(disposedOn: DateOnly): {
  startsOn: DateOnly;
  endsOn: DateOnly;
} {
  return {
    startsOn: addCalendarDays(disposedOn, -30),
    endsOn: addCalendarDays(disposedOn, 30),
  };
}

export function isInsideWashSaleWindow(
  disposedOn: DateOnly,
  acquiredOn: DateOnly,
): boolean {
  const window = washSaleWindow(disposedOn);
  return compareDateOnly(acquiredOn, window.startsOn) >= 0
    && compareDateOnly(acquiredOn, window.endsOn) <= 0;
}
