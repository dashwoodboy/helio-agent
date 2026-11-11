import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { dailyWeather } from "../db/schema.js";
import { localDateKey, localParts } from "../lib/time.js";
import type { SettingsService } from "./settings.js";

export interface CurrentWeather {
  temperature: number | null;
  weatherCode: number | null;
  windKmh: number | null;
  cloudCoverPct: number | null;
  isDay: boolean;
}

export interface DailyForecast {
  date: string;
  weatherCode: number | null;
  tempMax: number | null;
  tempMin: number | null;
  precipMm: number | null;
  /** Strongest wind gust of the day (km/h). */
  windGustsKmh: number | null;
  sunrise: string | null;
  sunset: string | null;
  /** Daily tilted irradiance sum in kWh/m2. */
  radiationKwhM2: number | null;
}

/** Severe weather that can interrupt grid power, derived from the forecast. */
export interface WeatherWarning {
  date: string;
  kind: "wind" | "rain" | "storm" | "snow";
  severity: "warn" | "critical";
  title: string;
  text: string;
}

export interface HourlyPoint {
  time: string;
  gtiWm2: number;
  cloudCoverPct: number | null;
  temperature: number | null;
}

export interface WeatherData {
  current: CurrentWeather;
  daily: DailyForecast[];
  hourly: HourlyPoint[];
  warnings: WeatherWarning[];
  fetchedAt: string;
}

// ------------------------------------------------------- severe weather
// Open-Meteo has no official alerts feed, so warnings are derived from the
// forecast. Thresholds target "could knock out grid power" weather.
const WIND_WARN_KMH = 70;
const WIND_CRITICAL_KMH = 90;
const RAIN_WARN_MM = 30;
const RAIN_CRITICAL_MM = 50;
/** WMO: 95 thunderstorm, 96/99 thunderstorm with hail. */
const STORM_CODES = new Set([95, 96, 99]);
const STORM_HAIL_CODES = new Set([96, 99]);
/** WMO: 66/67 freezing rain, 71-77 snow, 85/86 snow showers. */
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const FREEZING_RAIN_CODES = new Set([66, 67]);

/** "today" / "tomorrow" / "on Wednesday", relative to the local date keys. */
function dayPhrase(date: string, todayKey: string, tomorrowKey: string): string {
  if (date === todayKey) return "today";
  if (date === tomorrowKey) return "tomorrow";
  return `on ${new Date(`${date}T12:00`).toLocaleDateString("en-GB", { weekday: "long" })}`;
}

/**
 * Derive grid-outage-risk warnings from a daily forecast. Pure, so it is
 * unit-testable; one warning per matching condition per day.
 */
export function computeWarnings(daily: DailyForecast[], tz?: string): WeatherWarning[] {
  const todayKey = localDateKey(new Date(), tz);
  const tomorrowKey = localDateKey(new Date(Date.now() + 86400000), tz);
  const warnings: WeatherWarning[] = [];

  for (const d of daily) {
    if (d.date < todayKey) continue;
    const day = dayPhrase(d.date, todayKey, tomorrowKey);

    if (d.windGustsKmh !== null && d.windGustsKmh >= WIND_WARN_KMH) {
      warnings.push({
        date: d.date,
        kind: "wind",
        severity: d.windGustsKmh >= WIND_CRITICAL_KMH ? "critical" : "warn",
        title: `Strong wind ${day}`,
        text: `Gusts up to ${Math.round(d.windGustsKmh)} km/h — strong wind can bring down power lines.`,
      });
    }
    if (d.weatherCode !== null && STORM_CODES.has(d.weatherCode)) {
      warnings.push({
        date: d.date,
        kind: "storm",
        severity: STORM_HAIL_CODES.has(d.weatherCode) ? "critical" : "warn",
        title: `Thunderstorms ${day}`,
        text: "Lightning and surges can cause grid outages.",
      });
    }
    if (d.precipMm !== null && d.precipMm >= RAIN_WARN_MM) {
      warnings.push({
        date: d.date,
        kind: "rain",
        severity: d.precipMm >= RAIN_CRITICAL_MM ? "critical" : "warn",
        title: `Heavy rain ${day}`,
        text: `${Math.round(d.precipMm)} mm expected — flooding can interrupt grid power.`,
      });
    }
    if (d.weatherCode !== null && (SNOW_CODES.has(d.weatherCode) || FREEZING_RAIN_CODES.has(d.weatherCode))) {
      warnings.push({
        date: d.date,
        kind: "snow",
        severity: FREEZING_RAIN_CODES.has(d.weatherCode) ? "critical" : "warn",
        title: FREEZING_RAIN_CODES.has(d.weatherCode) ? `Freezing rain ${day}` : `Snow ${day}`,
        text: "Ice buildup on lines can interrupt grid power.",
      });
    }
  }
  return warnings;
}

/**
 * Shared Open-Meteo response cache. Environments at the same (rounded)
 * location with the same panel geometry reuse one upstream request, so the
 * free-tier quota scales with distinct locations rather than environments.
 */
const sharedFetchCache = new Map<string, { at: number; data: Promise<unknown> }>();
const SHARED_TTL_MS = 25 * 60000;

async function fetchOpenMeteo(url: string): Promise<unknown> {
  const hit = sharedFetchCache.get(url);
  if (hit && Date.now() - hit.at < SHARED_TTL_MS) return hit.data;
  const entry = {
    at: Date.now(),
    data: (async () => {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`Open-Meteo returned ${resp.status}`);
      return resp.json() as Promise<unknown>;
    })(),
  };
  sharedFetchCache.set(url, entry);
  try {
    return await entry.data;
  } catch (err) {
    sharedFetchCache.delete(url); // don't cache failures
    throw err;
  }
}

/**
 * Open-Meteo poller: current conditions, 7-day daily forecast and hourly
 * global tilted irradiance (using the configured panel tilt/azimuth) that
 * drives the PV forecast.
 */
export class WeatherService {
  private cache: WeatherData | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** Invoked with fresh warnings after every forecast fetch (alerting hook). */
  onWarnings: ((warnings: WeatherWarning[]) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly settingsService: SettingsService,
    private readonly environmentId: string,
    private readonly lat: number,
    private readonly lon: number,
    /** IANA timezone for day boundaries; process-local when omitted. */
    private readonly tz?: string,
    private readonly intervalMs = 30 * 60000,
  ) {}

  get data(): WeatherData | null {
    return this.cache;
  }

  start(): void {
    void this.fetchNow();
    this.timer = setInterval(() => void this.fetchNow(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private buildUrl(): string {
    const s = this.settingsService.get();
    const params = new URLSearchParams({
      // Rounded to ~1 km so nearby environments share one upstream request.
      latitude: String(Math.round(this.lat * 100) / 100),
      longitude: String(Math.round(this.lon * 100) / 100),
      current: "temperature_2m,weather_code,wind_speed_10m,cloud_cover,is_day",
      hourly: "global_tilted_irradiance,cloud_cover,temperature_2m",
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_gusts_10m_max,sunrise,sunset,shortwave_radiation_sum",
      timezone: "auto",
      forecast_days: "7",
      tilt: String(s.tiltDeg),
      azimuth: String(s.azimuthDeg),
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
  }

  async fetchNow(): Promise<void> {
    try {
      const raw = (await fetchOpenMeteo(this.buildUrl())) as Record<string, any>;
      const current = raw.current ?? {};
      const daily = raw.daily ?? {};
      const hourly = raw.hourly ?? {};

      const dailyList: DailyForecast[] = (daily.time ?? []).map((date: string, i: number) => ({
        date,
        weatherCode: daily.weather_code?.[i] ?? null,
        tempMax: daily.temperature_2m_max?.[i] ?? null,
        tempMin: daily.temperature_2m_min?.[i] ?? null,
        precipMm: daily.precipitation_sum?.[i] ?? null,
        windGustsKmh: daily.wind_gusts_10m_max?.[i] ?? null,
        sunrise: daily.sunrise?.[i]?.slice(11, 16) ?? null,
        sunset: daily.sunset?.[i]?.slice(11, 16) ?? null,
        radiationKwhM2: daily.shortwave_radiation_sum?.[i] != null
          ? Math.round((daily.shortwave_radiation_sum[i] / 3.6) * 100) / 100 // MJ/m2 -> kWh/m2
          : null,
      }));

      const hourlyList: HourlyPoint[] = (hourly.time ?? []).map((time: string, i: number) => ({
        time,
        gtiWm2: hourly.global_tilted_irradiance?.[i] ?? 0,
        cloudCoverPct: hourly.cloud_cover?.[i] ?? null,
        temperature: hourly.temperature_2m?.[i] ?? null,
      }));

      this.cache = {
        current: {
          temperature: current.temperature_2m ?? null,
          weatherCode: current.weather_code ?? null,
          windKmh: current.wind_speed_10m ?? null,
          cloudCoverPct: current.cloud_cover ?? null,
          isDay: current.is_day === 1,
        },
        daily: dailyList,
        hourly: hourlyList,
        warnings: computeWarnings(dailyList, this.tz),
        fetchedAt: new Date().toISOString(),
      };
      this.onWarnings?.(this.cache.warnings);

      await this.persistToday();
    } catch (err) {
      console.warn(`Weather fetch failed: ${(err as Error).message}`);
    }
  }

  /** Store today's weather + PV forecast in daily_weather for calibration. */
  private async persistToday(): Promise<void> {
    if (!this.cache) return;
    const todayKey = localDateKey(new Date(), this.tz);
    const today = this.cache.daily.find((d) => d.date === todayKey);
    if (!today) return;
    const forecastPvKwh = this.forecastForDate(todayKey)?.forecastKwh ?? null;
    const row = {
      environmentId: this.environmentId,
      date: todayKey,
      weatherCode: today.weatherCode,
      tempMax: today.tempMax,
      tempMin: today.tempMin,
      precipMm: today.precipMm,
      radiationKwhM2: today.radiationKwhM2,
      forecastPvKwh,
      sunrise: today.sunrise,
      sunset: today.sunset,
    };
    await this.db
      .insert(dailyWeather)
      .values(row)
      .onConflictDoUpdate({
        target: [dailyWeather.environmentId, dailyWeather.date],
        set: { ...row, environmentId: undefined as never, date: undefined as never },
      });
  }

  /** Calibration factor: median(actual/forecast) over recent days. */
  async calibrationFactor(): Promise<number> {
    const since = localDateKey(new Date(Date.now() - 21 * 86400000), this.tz);
    const rows = await this.db
      .select()
      .from(dailyWeather)
      .where(and(eq(dailyWeather.environmentId, this.environmentId), gte(dailyWeather.date, since)));
    const ratios = rows
      .filter((r) => (r.forecastPvKwh ?? 0) > 0.5 && (r.actualPvKwh ?? 0) > 0.1)
      .map((r) => (r.actualPvKwh as number) / (r.forecastPvKwh as number))
      .sort((a, b) => a - b);
    if (ratios.length < 5) return 1;
    const median = ratios[Math.floor(ratios.length / 2)];
    return Math.min(1.5, Math.max(0.5, median));
  }

  /** Hourly expected PV power (W) from tilted irradiance. */
  hourlyPvForecast(calibration = 1): { time: string; pvW: number }[] {
    if (!this.cache) return [];
    const s = this.settingsService.get();
    return this.cache.hourly.map((h) => ({
      time: h.time,
      pvW: Math.round(h.gtiWm2 * s.pvKwp * s.performanceRatio * calibration),
    }));
  }

  /** Daily PV forecast (kWh) for a date present in the hourly data. */
  forecastForDate(date: string, calibration = 1): { date: string; forecastKwh: number } | null {
    if (!this.cache) return null;
    const s = this.settingsService.get();
    const hours = this.cache.hourly.filter((h) => h.time.startsWith(date));
    if (hours.length === 0) return null;
    const kwh =
      hours.reduce((sum, h) => sum + h.gtiWm2, 0) / 1000 * s.pvKwp * s.performanceRatio * calibration;
    return { date, forecastKwh: Math.round(kwh * 100) / 100 };
  }
}
