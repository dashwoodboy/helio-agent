/**
 * Unit conversion for server-generated texts (alerts, weather warnings).
 * Values are always STORED metric (°C, km/h, mm); only the formatting of
 * user-facing strings follows the environment's `units` setting.
 */

export type Units = "metric" | "us";

export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const fToC = (f: number): number => ((f - 32) * 5) / 9;
export const kmhToMph = (kmh: number): number => kmh / 1.609344;
export const mmToIn = (mm: number): number => mm / 25.4;

export function fmtTemp(celsius: number, units: Units, digits = 1): string {
  return units === "us" ? `${cToF(celsius).toFixed(digits)}°F` : `${celsius.toFixed(digits)}°C`;
}

export function fmtWind(kmh: number, units: Units): string {
  return units === "us" ? `${Math.round(kmhToMph(kmh))} mph` : `${Math.round(kmh)} km/h`;
}

export function fmtRain(mm: number, units: Units): string {
  return units === "us" ? `${mmToIn(mm).toFixed(1)} in` : `${Math.round(mm)} mm`;
}
