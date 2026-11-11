/**
 * Battery time-to-full / time-to-empty estimate, ported from the Python
 * estimate_charge_time with a rolling window to smooth the power input.
 */
export interface ChargeEstimate {
  status: "charging" | "discharging" | "full" | "idle";
  /** Minutes to full (charging) or to empty (discharging). */
  minutes: number | null;
  /** Local HH:MM when full/empty. */
  etaClock: string | null;
  remainingKwh: number | null;
  powerW: number;
  capacityKwh: number;
}

export function estimateChargeTime(
  soc: number | null,
  batteryPowerW: number,
  capacityKwh: number,
  minSocPct = 10,
  now: Date = new Date(),
): ChargeEstimate {
  const power = batteryPowerW || 0;
  const result: ChargeEstimate = {
    status: "idle",
    minutes: null,
    etaClock: null,
    remainingKwh: null,
    powerW: Math.round(power),
    capacityKwh,
  };
  if (soc === null || capacityKwh <= 0) return result;
  if (soc >= 100 && power >= -50) {
    result.status = "full";
    return result;
  }

  if (power > 50) {
    // Charging
    const remainingKwh = ((100 - soc) / 100) * capacityKwh;
    let hours = (remainingKwh * 1000) / power;
    // The top of the charge curve tapers: above ~90% assume 1.5x.
    if (soc >= 90) hours *= 1.5;
    const minutes = Math.round(hours * 60);
    const eta = new Date(now.getTime() + minutes * 60000);
    return {
      ...result,
      status: "charging",
      minutes,
      etaClock: eta.toTimeString().slice(0, 5),
      remainingKwh: Math.round(remainingKwh * 100) / 100,
    };
  }

  if (power < -50) {
    // Discharging: estimate time until the usable floor.
    const usablePct = Math.max(0, soc - minSocPct);
    const remainingKwh = (usablePct / 100) * capacityKwh;
    const minutes = Math.round((remainingKwh * 1000) / -power * 60);
    const eta = new Date(now.getTime() + minutes * 60000);
    return {
      ...result,
      status: "discharging",
      minutes,
      etaClock: eta.toTimeString().slice(0, 5),
      remainingKwh: Math.round(remainingKwh * 100) / 100,
    };
  }

  return result;
}

/** Rolling average of recent battery power samples for a stable ETA. */
export class PowerWindow {
  private samples: number[] = [];
  constructor(private readonly maxSamples = 24) {}

  add(powerW: number): void {
    // Reset the window when direction flips so the ETA adapts quickly.
    if (
      this.samples.length > 0 &&
      Math.sign(powerW) !== Math.sign(this.samples[this.samples.length - 1])
    ) {
      this.samples = [];
    }
    this.samples.push(powerW);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  average(): number | null {
    if (this.samples.length === 0) return null;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }
}
