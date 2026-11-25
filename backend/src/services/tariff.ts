import type { AppSettings, TariffPeriod } from "./settings.js";

/** The day is split into 48 half-hour slots; slot 0 = 00:00-00:30. */
export const SLOTS_PER_DAY = 48;

export function timeToSlot(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 2 + (m >= 30 ? 1 : 0);
}

export function slotOf(date: Date): number {
  return date.getHours() * 2 + (date.getMinutes() >= 30 ? 1 : 0);
}

/**
 * Which period owns each half-hour slot; -1 = none (default price).
 * Periods may wrap past midnight (start > end). On overlap the earlier
 * period in the list wins. start === end means an empty period.
 */
export function slotPeriodIndex(periods: TariffPeriod[]): number[] {
  const slots = new Array<number>(SLOTS_PER_DAY).fill(-1);
  periods.forEach((p, idx) => {
    const start = timeToSlot(p.start);
    const end = timeToSlot(p.end);
    for (let s = start; s !== end; s = (s + 1) % SLOTS_PER_DAY) {
      if (slots[s] === -1) slots[s] = idx;
    }
  });
  return slots;
}

/** Import price per half-hour slot, falling back to the default importPrice. */
export function slotPrices(s: Pick<AppSettings, "tariffPeriods" | "importPrice">): number[] {
  const idx = slotPeriodIndex(s.tariffPeriods);
  return idx.map((i) => (i === -1 ? s.importPrice : s.tariffPeriods[i].price));
}

/** Time-weighted average import price over a full day. */
export function averageImportPrice(s: Pick<AppSettings, "tariffPeriods" | "importPrice">): number {
  const prices = slotPrices(s);
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}
