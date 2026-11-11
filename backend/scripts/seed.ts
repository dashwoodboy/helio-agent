/**
 * Seed ~400 days of plausible history so month/year/lifetime pages have
 * data immediately. Usage: DATABASE_URL=... npm run seed
 *
 * Rows go to the environment in SEED_ENV_ID (defaults to the legacy
 * environment id); the environment is created when missing.
 */
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  dailyEnergy,
  dailyWeather,
  environments,
  outageEvents,
  telemetry,
} from "../src/db/schema.js";
import {
  clearSkyPvW,
  householdLoadW,
  seededRandom,
  sunWindow,
  weatherFactorFor,
} from "../src/inverter/simulator.js";
import { LEGACY_ENV_ID } from "../src/auth/plugin.js";
import { localDateKey } from "../src/lib/time.js";
import { computeFlows } from "../src/services/flows.js";

const KWP = 5.5;
const CAPACITY_KWH = 16;
const DAYS = 400;
const ENV_ID = process.env.SEED_ENV_ID ?? LEGACY_ENV_ID;

const { db, pool } = createDb();
await runMigrations(db);

const envRows = await db.select().from(environments).where(eq(environments.id, ENV_ID));
if (envRows.length === 0) {
  await db.insert(environments).values({
    id: ENV_ID,
    name: "Demo environment",
    timezone: process.env.TZ ?? "UTC",
    sourceType: "simulator",
  });
  console.log(`Created environment ${ENV_ID}`);
}

console.log("Seeding daily history...");
const today = new Date();
const dailyRows: (typeof dailyEnergy.$inferInsert)[] = [];
const weatherRows: (typeof dailyWeather.$inferInsert)[] = [];
const outageRows: (typeof outageEvents.$inferInsert)[] = [];

for (let i = DAYS; i >= 1; i--) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12);
  const dateKey = localDateKey(d);
  const rnd = seededRandom(d.getFullYear() * 1000 + i);
  const weather = weatherFactorFor(d);
  const { sunrise, sunset } = sunWindow(d);

  // Integrate the clear-sky curve for the day's PV total.
  let pvKwh = 0;
  for (let h = 0; h < 24; h += 0.25) {
    pvKwh += (clearSkyPvW(d, h, KWP) * weather) / 1000 / 4;
  }
  pvKwh = Math.round(pvKwh * 10) / 10;

  const loadKwh = Math.round((9 + rnd() * 6) * 10) / 10;

  // Plausible flow split.
  const pvToLoad = Math.min(pvKwh, loadKwh) * (0.45 + rnd() * 0.15);
  const pvToBatt = Math.min(Math.max(0, pvKwh - pvToLoad), CAPACITY_KWH * 0.65);
  const pvToGrid = Math.max(0, pvKwh - pvToLoad - pvToBatt);
  const battToLoad = Math.min(pvToBatt * 0.92, Math.max(0, loadKwh - pvToLoad));
  const gridToLoad = Math.max(0, loadKwh - pvToLoad - battToLoad);
  const nightShare = 0.35 + rnd() * 0.15;

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  // Half-hour import slots: night share into 22:00-07:00, the rest daytime.
  const importSlots = new Array<number>(48).fill(0);
  const nightSlotIdx = [...Array(48).keys()].filter((s) => s >= 44 || s < 14);
  const daySlotIdx = [...Array(48).keys()].filter((s) => s < 44 && s >= 14);
  for (const s of nightSlotIdx) importSlots[s] = r3((gridToLoad * nightShare) / nightSlotIdx.length);
  for (const s of daySlotIdx) importSlots[s] = r3((gridToLoad * (1 - nightShare)) / daySlotIdx.length);
  dailyRows.push({
    environmentId: ENV_ID,
    date: dateKey,
    pvKwh,
    importKwh: r2(gridToLoad),
    exportKwh: r2(pvToGrid),
    loadKwh,
    battChargeKwh: r2(pvToBatt),
    battDischargeKwh: r2(battToLoad),
    genKwh: 0,
    pvToLoadKwh: r2(pvToLoad),
    pvToBattKwh: r2(pvToBatt),
    pvToGridKwh: r2(pvToGrid),
    gridToLoadKwh: r2(gridToLoad),
    gridToBattKwh: 0,
    battToLoadKwh: r2(battToLoad),
    importDayKwh: r2(gridToLoad * (1 - nightShare)),
    importNightKwh: r2(gridToLoad * nightShare),
    importSlotsKwh: importSlots,
    peakPvW: Math.round(KWP * 1000 * weather * (0.8 + rnd() * 0.15)),
    peakLoadW: Math.round(1800 + rnd() * 2200),
    l1Kwh: loadKwh,
    l2Kwh: 0,
    l3Kwh: 0,
    socMin: Math.round(18 + rnd() * 30),
    socMax: Math.round(88 + rnd() * 12),
    battVMin: r2(49 + rnd()),
    battVMax: r2(55 + rnd()),
    source: "seed",
  });

  const fmtH = (h: number) =>
    `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const forecast = pvKwh * (0.85 + rnd() * 0.3);
  weatherRows.push({
    environmentId: ENV_ID,
    date: dateKey,
    weatherCode: weather > 0.75 ? 1 : weather > 0.5 ? 3 : 61,
    tempMax: r2(12 + 14 * Math.cos(((i - 220) / 365) * 2 * Math.PI) + rnd() * 5),
    tempMin: r2(4 + 10 * Math.cos(((i - 220) / 365) * 2 * Math.PI) + rnd() * 4),
    precipMm: weather < 0.5 ? r2(rnd() * 12) : 0,
    radiationKwhM2: r2((pvKwh / KWP / 0.85) * (0.95 + rnd() * 0.1)),
    forecastPvKwh: r2(forecast),
    actualPvKwh: pvKwh,
    sunrise: fmtH(sunrise),
    sunset: fmtH(sunset),
  });

  // Roughly one outage every 10 days.
  if (rnd() < 0.1) {
    const startH = 8 + rnd() * 12;
    const durationMin = 30 + rnd() * 120;
    const start = new Date(d);
    start.setHours(Math.floor(startH), Math.round((startH % 1) * 60), 0, 0);
    outageRows.push({
      environmentId: ENV_ID,
      startedAt: start,
      endedAt: new Date(start.getTime() + durationMin * 60000),
      durationS: Math.round(durationMin * 60),
      minSoc: Math.round(25 + rnd() * 50),
    });
  }
}

for (const row of dailyRows) {
  await db.insert(dailyEnergy).values(row).onConflictDoUpdate({
    target: [dailyEnergy.environmentId, dailyEnergy.date],
    set: row,
  });
}
for (const row of weatherRows) {
  await db.insert(dailyWeather).values(row).onConflictDoUpdate({
    target: [dailyWeather.environmentId, dailyWeather.date],
    set: row,
  });
}
if (outageRows.length > 0) await db.insert(outageEvents).values(outageRows);

console.log(`Seeded ${dailyRows.length} days, ${outageRows.length} outages.`);

console.log("Seeding 48h of minute telemetry...");
const telemetryRows: (typeof telemetry.$inferInsert)[] = [];
let soc = 55;
const start = new Date(today.getTime() - 48 * 3600000);
const rnd = seededRandom(1234);
for (let t = start.getTime(); t < today.getTime(); t += 60000) {
  const ts = new Date(t);
  const hour = ts.getHours() + ts.getMinutes() / 60;
  const weather = weatherFactorFor(ts);
  const pvW = Math.round(clearSkyPvW(ts, hour, KWP) * weather * (0.92 + rnd() * 0.16));
  const loadW = Math.round(householdLoadW(hour, rnd));
  const surplus = pvW - loadW;
  let battW = 0;
  let gridW = 0;
  if (surplus >= 0) {
    battW = soc >= 99.5 ? 0 : Math.min(surplus, 5500);
    gridW = -(surplus - battW);
  } else {
    const discharge = soc <= 20 ? 0 : Math.min(-surplus, 6000);
    battW = -discharge;
    gridW = -surplus - discharge;
  }
  soc = Math.min(100, Math.max(8, soc + ((battW / 1000 / 60) / CAPACITY_KWH) * 100 * 0.96));
  const battV = 48 + (soc / 100) * 5.2;
  const flows = computeFlows({ pvW, loadW, gridW, battW, genW: 0 });
  void flows;
  telemetryRows.push({
    environmentId: ENV_ID,
    ts,
    pv1W: Math.round(pvW * 0.55),
    pv2W: pvW - Math.round(pvW * 0.55),
    pvW,
    loadW,
    gridW,
    battW,
    battV: Math.round(battV * 100) / 100,
    battA: Math.round((battW / battV) * 100) / 100,
    soc: Math.round(soc),
    gridV: Math.round((228 + rnd() * 8) * 10) / 10,
    gridHz: 50,
    genW: 0,
    dcTemp: Math.round((32 + pvW / 400) * 10) / 10,
    heatsinkTemp: Math.round((28 + pvW / 500) * 10) / 10,
    l1W: loadW,
    l1V: Math.round((228 + rnd() * 8) * 10) / 10,
  });
}
// Insert in chunks.
for (let i = 0; i < telemetryRows.length; i += 500) {
  await db.insert(telemetry).values(telemetryRows.slice(i, i + 500));
}
console.log(`Seeded ${telemetryRows.length} telemetry rows.`);

await pool.end();
console.log("Done.");
