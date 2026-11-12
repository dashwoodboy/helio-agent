/**
 * Pure decision logic for alert spam control. The AlertEngine owns the
 * database and timers; everything here is deterministic state so it can be
 * unit-tested without a database:
 *
 *  - edge-triggered transitions (fire when a condition *becomes* true);
 *  - storm-warning signatures (fire when the warning *changes*, and notice
 *    when it clears);
 *  - once-per-local-day dedupe per rule+signature, seedable from the
 *    notifications table so restarts don't repeat alerts.
 */
import type { WeatherWarning } from "./weather.js";

/**
 * Rules describing an ongoing condition: they fire on transitions and at
 * most once per local day per signature. Event rules (grid lost/restored,
 * generator start/stop) stay out — a second real outage in the same day
 * deserves its own alert.
 */
export const DAY_DEDUPED_RULES: ReadonlySet<string> = new Set([
  "socLow",
  "socCritical",
  "batteryFull",
  "tempHigh",
  "gridVOutOfRange",
  "inverterOffline",
  "pvUnderperforming",
  "stormWarning",
  "stormCleared",
]);

export interface SignatureChange {
  /** A (different) warning is now active: worth alerting. */
  changed: boolean;
  /** A previously-announced warning is gone: worth an all-clear. */
  cleared: boolean;
}

/** The worst warning within the next ~48 h, as a stable signature string. */
export function stormSignature(
  warnings: WeatherWarning[],
  todayKey: string,
  tomorrowKey: string,
): { signature: string | null; worst: WeatherWarning | null } {
  const soon = warnings.filter((w) => w.date >= todayKey && w.date <= tomorrowKey);
  if (soon.length === 0) return { signature: null, worst: null };
  const worst = [...soon].sort((a, b) =>
    a.severity === b.severity ? a.date.localeCompare(b.date) : a.severity === "critical" ? -1 : 1,
  )[0];
  return { signature: `${worst.kind}|${worst.severity}|${worst.date}`, worst };
}

export class AlertDeduper {
  /** Whether each edge-triggered rule's condition is currently true. */
  private inState = new Map<string, boolean>();
  /** Last signature fed per rule (null = explicitly none, missing = unknown). */
  private lastSignature = new Map<string, string | null>();
  /** "rule|signature" keys fired on the current day. */
  private fired = new Set<string>();
  private firedDay = "";

  /**
   * Feed the current truth of a condition; returns true only on the
   * false→true edge. Recovering (true→false) re-arms the rule.
   */
  transition(rule: string, active: boolean): boolean {
    const was = this.inState.get(rule) ?? false;
    this.inState.set(rule, active);
    return active && !was;
  }

  /**
   * Feed the current signature of a signature-tracked rule (null = no
   * condition). `changed` is true when a new, different signature appears;
   * `cleared` only when a signature this process knew about goes away, so a
   * restart with no active warning never announces a phantom all-clear.
   */
  updateSignature(rule: string, signature: string | null): SignatureChange {
    const prev = this.lastSignature.get(rule);
    this.lastSignature.set(rule, signature);
    return {
      changed: signature !== null && signature !== prev,
      cleared: signature === null && typeof prev === "string",
    };
  }

  /** Restore a known signature (e.g. from today's notifications at boot). */
  seedSignature(rule: string, signature: string | null): void {
    this.lastSignature.set(rule, signature);
  }

  /** True when this rule+signature has not been emitted yet on `dayKey`. */
  shouldFire(rule: string, dayKey: string, signature = ""): boolean {
    this.rollDay(dayKey);
    return !this.fired.has(`${rule}|${signature}`);
  }

  markFired(rule: string, dayKey: string, signature = ""): void {
    this.rollDay(dayKey);
    this.fired.add(`${rule}|${signature}`);
  }

  /** A new local day forgets yesterday's emissions. */
  private rollDay(dayKey: string): void {
    if (dayKey !== this.firedDay) {
      this.fired.clear();
      this.firedDay = dayKey;
    }
  }
}
