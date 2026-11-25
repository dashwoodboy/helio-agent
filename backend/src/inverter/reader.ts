import type { RegisterTransport } from "../solarman/transport.js";
import { toSigned } from "../solarman/modbus.js";
import { AsyncMutex } from "../lib/mutex.js";
import { DETECT, REG_1P, REG_3P } from "./registers.js";
import { BatterySmoother } from "./smoothing.js";
import {
  deriveStatuses,
  type FullReading,
  type InverterConfig,
  type InverterSource,
  type LiveReading,
} from "./types.js";
import type { CapabilityOverrides } from "../config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pause between register reads so the logger isn't overwhelmed. */
const INTER_READ_MS = 50;

export class DeyeInverter implements InverterSource {
  private readonly smoother = new BatterySmoother();
  /** Optional registers that failed once are skipped afterwards. */
  private readonly unavailable = new Set<string>();

  constructor(
    private readonly client: RegisterTransport,
    private readonly overrides: CapabilityOverrides = {},
    /** Shared per-environment lock so settings writes never interleave with polls. */
    private readonly mutex: AsyncMutex = new AsyncMutex(),
  ) {}

  async close(): Promise<void> {
    await this.client.disconnect();
  }

  private async read(start: number, count: number): Promise<number[]> {
    const values = await this.client.readHoldingRegisters(start, count);
    await sleep(INTER_READ_MS);
    return values;
  }

  private async readOptional(key: string, start: number, count: number): Promise<number[] | null> {
    if (this.unavailable.has(key)) return null;
    try {
      return await this.read(start, count);
    } catch {
      this.unavailable.add(key);
      return null;
    }
  }

  // ---------------------------------------------------------------- detect

  detectConfig(): Promise<InverterConfig> {
    return this.mutex.runExclusive(() => this.detectConfigUnlocked());
  }

  private async detectConfigUnlocked(): Promise<InverterConfig> {
    const o = this.overrides;
    if (
      o.phases !== undefined &&
      o.hasBattery !== undefined &&
      o.pvStrings !== undefined &&
      o.hasGenerator !== undefined
    ) {
      const cached: InverterConfig = {
        phases: o.phases,
        hasBattery: o.hasBattery,
        pvStrings: o.pvStrings,
        hasGenerator: o.hasGenerator,
        ...(o.hv !== undefined ? { hv: o.hv } : {}),
      };
      // 1-phase configs never need hv; a complete 3-phase config skips too.
      if (o.phases !== 3 || o.hv !== undefined) return cached;
      // 3-phase config cached before hv existed: one read fills the gap.
      try {
        await this.client.connect();
        return { ...cached, hv: await this.detectHv() };
      } finally {
        await this.client.disconnect();
      }
    }

    try {
      await this.client.connect();

      // Stage 1: phase count via L2/L3 voltage (2 samples).
      let phases3 = false;
      for (let i = 0; i < 2; i++) {
        try {
          const [vL2, vL3] = await this.read(DETECT.phaseVoltageL2, 2);
          if (vL2 / 10 > 50 || vL3 / 10 > 50) phases3 = true;
        } catch {
          // Register missing on 1-phase models — treat as 1-phase evidence.
        }
        if (i === 0 && !phases3) await sleep(1000);
      }
      const phases: 1 | 3 = o.phases ?? (phases3 ? 3 : 1);

      // Stage 2: battery voltage + PV2 using the right map.
      const battReg = phases === 3 ? DETECT.battV3p : DETECT.battV1p;
      const pv2Reg = phases === 3 ? DETECT.pv2_3p : DETECT.pv2_1p;
      let hasBattery = false;
      let pv2Detected = false;
      for (let i = 0; i < 2; i++) {
        try {
          const [battRaw] = await this.read(battReg, 1);
          if (battRaw / 100 > 10) hasBattery = true;
        } catch { /* keep default */ }
        try {
          const [pv2] = await this.read(pv2Reg, 1);
          if (pv2 > 0) pv2Detected = true;
        } catch { /* keep default */ }
        if (i === 0) await sleep(1000);
      }
      // Default to battery present / 2 strings when detection is ambiguous
      // (readings can be 0 at night), mirroring the Python behaviour.
      if (!hasBattery) hasBattery = true;
      if (!pv2Detected) pv2Detected = true;

      // Stage 3: generator.
      const genReg = phases === 3 ? DETECT.gen3p : DETECT.gen1p;
      let hasGenerator = false;
      try {
        const [genW] = await this.read(genReg, 1);
        if (genW > 0) hasGenerator = true;
      } catch { /* keep default */ }

      // Stage 4 (3-phase only): LV vs HV family via the device-type register.
      const hv = phases === 3 ? (o.hv ?? (await this.detectHv())) : undefined;

      return {
        phases,
        hasBattery: o.hasBattery ?? hasBattery,
        pvStrings: o.pvStrings ?? (pv2Detected ? 2 : 1),
        hasGenerator: o.hasGenerator ?? hasGenerator,
        ...(hv !== undefined ? { hv } : {}),
      };
    } finally {
      await this.client.disconnect();
    }
  }

  /**
   * Device-type register 0: 0x05xx = 3-phase LV (SG04LP3), 0x06xx = 3-phase
   * HV (SG01HP3). Defaults to LV when the register can't be read.
   */
  private async detectHv(): Promise<boolean> {
    try {
      const [deviceType] = await this.read(DETECT.deviceType, 1);
      return (deviceType & 0xff00) === 0x0600;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ live

  readLive(config: InverterConfig): Promise<LiveReading> {
    return this.mutex.runExclusive(() => this.readLiveUnlocked(config));
  }

  private async readLiveUnlocked(config: InverterConfig): Promise<LiveReading> {
    try {
      await this.client.connect();
      return config.phases === 1
        ? await this.readLive1p(config)
        : await this.readLive3p(config);
    } finally {
      await this.client.disconnect();
    }
  }

  private applyBattery(
    raw: { battV: number; battA: number; socRaw: number },
    config: InverterConfig,
  ): { battV: number; battA: number; soc: number; socRaw: number; battW: number } {
    if (!config.hasBattery) {
      return { battV: 0, battA: 0, soc: 0, socRaw: 0, battW: 0 };
    }
    this.smoother.addSample(raw.battV, raw.socRaw);
    const battV = this.smoother.getVoltage() ?? raw.battV;
    const soc = this.smoother.getSoc() ?? raw.socRaw;
    return {
      battV,
      battA: raw.battA,
      soc,
      socRaw: raw.socRaw,
      battW: Math.round(battV * raw.battA),
    };
  }

  private async readLive1p(config: InverterConfig): Promise<LiveReading> {
    const [gridVRaw] = await this.read(REG_1P.gridV, 1);
    const blkA = await this.read(REG_1P.liveBlockA.start, REG_1P.liveBlockA.count);
    const blkB = await this.read(REG_1P.liveBlockB.start, REG_1P.liveBlockB.count);

    const gridV = gridVRaw / 10;
    const genW = config.hasGenerator ? blkA[0] : 0;
    const gridW = toSigned(blkA[3]);
    const l1W = blkA[10];
    const loadW = blkA[12];
    const pv1W = blkB[3];
    const pv2W = config.pvStrings >= 2 ? blkB[4] : 0;

    const batt = this.applyBattery(
      {
        battV: blkB[0] / 100,
        socRaw: blkB[1],
        battA: -toSigned(blkB[8]) / 100,
      },
      config,
    );

    const gridHzRaw = await this.readOptional("gridHz1p", REG_1P.gridHz, 1);

    const statuses = deriveStatuses({
      battA: batt.battA,
      gridW,
      gridV,
      hasBattery: config.hasBattery,
    });

    return {
      pv1W,
      pv2W,
      pvW: pv1W + pv2W,
      ...batt,
      gridV,
      gridW,
      gridHz: gridHzRaw ? gridHzRaw[0] / 100 : null,
      loadW,
      genW,
      l1W,
      l2W: null,
      l3W: null,
      l1V: gridV,
      l2V: null,
      l3V: null,
      ...statuses,
    };
  }

  private async readLive3p(config: InverterConfig): Promise<LiveReading> {
    // HV family (SG01HP3): PV power in 10 W steps, battery voltage in 0.1 V.
    const pvScale = config.hv ? 10 : 1;
    const battVScale = config.hv ? 10 : 100;

    const pv = await this.read(REG_3P.pvBlock.start, REG_3P.pvBlock.count);
    const pv1W = pv[0] * pvScale;
    const pv2W = config.pvStrings >= 2 ? pv[1] * pvScale : 0;

    let batt = { battV: 0, battA: 0, soc: 0, socRaw: 0, battW: 0 };
    if (config.hasBattery) {
      // 587 V, 588 SOC, 591 A (signed; raw positive = discharging, negate).
      const b = await this.read(REG_3P.battBlock.start, REG_3P.battBlock.count);
      batt = this.applyBattery(
        { battV: b[0] / battVScale, socRaw: b[1], battA: -toSigned(b[4]) / 100 },
        config,
      );
    }

    // 598..600 phase voltages; 609 frequency. The grid total power lives in
    // its own register (625) — 607 in this block is the inner-side power.
    const grid = await this.read(REG_3P.gridBlock.start, REG_3P.gridBlock.count);
    const gridV = grid[0] / 10;
    const l2V = grid[1] / 10;
    const l3V = grid[2] / 10;
    const gridHz = grid.length >= 12 && grid[11] > 4000 ? grid[11] / 100 : null;
    const [gridPowerRaw] = await this.read(REG_3P.gridPower, 1);
    const gridW = toSigned(gridPowerRaw);

    const phase = await this.read(REG_3P.phaseBlock.start, REG_3P.phaseBlock.count);
    const loadW = phase[9];

    let genW = 0;
    if (config.hasGenerator) {
      const [g] = await this.read(REG_3P.generator, 1);
      genW = g;
    }

    const statuses = deriveStatuses({
      battA: batt.battA,
      gridW,
      gridV,
      hasBattery: config.hasBattery,
    });

    return {
      pv1W,
      pv2W,
      pvW: pv1W + pv2W,
      ...batt,
      gridV,
      gridW,
      gridHz,
      loadW,
      genW,
      l1W: phase[6],
      l2W: phase[7],
      l3W: phase[8],
      l1V: gridV,
      l2V,
      l3V,
      ...statuses,
    };
  }

  // ------------------------------------------------------------------ full

  readFull(config: InverterConfig): Promise<FullReading> {
    return this.mutex.runExclusive(() => this.readFullUnlocked(config));
  }

  private async readFullUnlocked(config: InverterConfig): Promise<FullReading> {
    try {
      await this.client.connect();
      const live =
        config.phases === 1
          ? await this.readLive1p(config)
          : await this.readLive3p(config);
      const slow =
        config.phases === 1
          ? await this.readSlow1p(config)
          : await this.readSlow3p();
      return { ...live, ...slow };
    } finally {
      await this.client.disconnect();
    }
  }

  private async readSlow1p(config: InverterConfig) {
    const [dcRaw] = await this.read(REG_1P.dcTemp, 1);
    const [hsRaw] = await this.read(REG_1P.heatsinkTemp, 1);
    const [dailyPv] = await this.read(REG_1P.dailyPv, 1);
    const [dailyImport] = await this.read(REG_1P.dailyImport, 1);
    const [dailyExport] = await this.read(REG_1P.dailyExport, 1);
    const [dailyLoad] = await this.read(REG_1P.dailyLoad, 1);

    const dailyBatt = await this.readOptional(
      "dailyBatt1p",
      REG_1P.dailyBattBlock.start,
      REG_1P.dailyBattBlock.count,
    );
    const totalPv = await this.readOptional(
      "totalPv1p",
      REG_1P.totalPvBlock.start,
      REG_1P.totalPvBlock.count,
    );

    let batteryCapacityAh: number | null = null;
    let batteryNominalV: number | null = null;
    if (config.hasBattery) {
      const cap = await this.readOptional("battCap1p", REG_1P.batteryCapacityAh, 1);
      const nom = await this.readOptional("battNom1p", REG_1P.batteryNominalV, 1);
      batteryCapacityAh = cap ? cap[0] : null;
      batteryNominalV = nom ? nom[0] / 100 : null;
    }

    return {
      dcTemp: (dcRaw - 1000) / 10,
      heatsinkTemp: (hsRaw - 1000) / 10,
      dailyPvKwh: dailyPv / 10,
      dailyImportKwh: dailyImport / 10,
      dailyExportKwh: dailyExport / 10,
      dailyLoadKwh: dailyLoad / 10,
      dailyBattChargeKwh: dailyBatt ? dailyBatt[0] / 10 : null,
      dailyBattDischargeKwh: dailyBatt ? dailyBatt[1] / 10 : null,
      // 32-bit counter, low word first (reg 96 = low, reg 97 = high).
      totalPvKwh: totalPv ? (totalPv[1] * 65536 + totalPv[0]) / 10 : null,
      batteryCapacityAh,
      batteryNominalV,
    };
  }

  private async readSlow3p() {
    const [dcRaw] = await this.read(REG_3P.dcTemp, 1);
    const [hsRaw] = await this.read(REG_3P.heatsinkTemp, 1);
    // 514..529: [0]/[1] battery charge/discharge, [6] import, [7] export,
    // [12] load, [15] PV — all day counters in 0.1 kWh.
    const daily = await this.read(REG_3P.dailyBlock.start, REG_3P.dailyBlock.count);
    const totalPv = await this.readOptional(
      "totalPv3p",
      REG_3P.totalPvBlock.start,
      REG_3P.totalPvBlock.count,
    );

    return {
      dcTemp: (dcRaw - 1000) / 10,
      heatsinkTemp: (hsRaw - 1000) / 10,
      dailyPvKwh: daily[15] / 10,
      dailyImportKwh: daily[6] / 10,
      dailyExportKwh: daily[7] / 10,
      dailyLoadKwh: daily[12] / 10,
      dailyBattChargeKwh: daily[0] / 10,
      dailyBattDischargeKwh: daily[1] / 10,
      // 32-bit counter, low word first (reg 534 = low, reg 535 = high).
      totalPvKwh: totalPv ? (totalPv[1] * 65536 + totalPv[0]) / 10 : null,
      batteryCapacityAh: null,
      batteryNominalV: null,
    };
  }
}
