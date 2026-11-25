/**
 * Timezone-aware date helpers. Every environment has its own IANA timezone;
 * when `tz` is omitted the process-local timezone is used (matching the old
 * single-tenant behaviour and keeping existing tests valid).
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(d: Date, tz?: string): LocalParts {
  if (!tz) {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
    };
  }
  const parts = getFormatter(tz).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl can report hour 24 at midnight with some locales/options; normalize.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** "YYYY-MM-DD" in the given timezone (process-local when omitted). */
export function localDateKey(d: Date, tz?: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Local hour of day (0-23) in the given timezone. */
export function localHour(d: Date, tz?: string): number {
  return localParts(d, tz).hour;
}

/** Half-hour slot of day (0-47) in the given timezone. */
export function localSlot(d: Date, tz?: string): number {
  const p = localParts(d, tz);
  return p.hour * 2 + (p.minute >= 30 ? 1 : 0);
}

function tzOffsetMs(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/** UTC instant of local midnight for "YYYY-MM-DD" in the given timezone. */
export function zonedDayStart(dateKey: string, tz?: string): Date {
  if (!tz) return new Date(`${dateKey}T00:00:00`);
  const guess = new Date(`${dateKey}T00:00:00Z`);
  let offset = tzOffsetMs(guess, tz);
  let ts = guess.getTime() - offset;
  // One refinement pass handles DST transitions around midnight.
  const refined = tzOffsetMs(new Date(ts), tz);
  if (refined !== offset) ts = guess.getTime() - refined;
  return new Date(ts);
}

/** True when `tz` is a valid IANA timezone identifier. */
export function isValidTimezone(tz: string): boolean {
  try {
    getFormatter(tz);
    return true;
  } catch {
    return false;
  }
}
