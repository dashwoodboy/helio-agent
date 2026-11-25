/**
 * Battery smoothing, ported from the Python BatterySampler: rolling
 * average for voltage (with plausibility window) and rolling median
 * for SOC to reject single-sample outliers.
 */
export class BatterySmoother {
  private voltageBuffer: number[] = [];
  private socBuffer: number[] = [];

  constructor(private readonly bufferSize = 6) {}

  addSample(voltage: number, soc: number): void {
    if (voltage >= 40 && voltage <= 60) {
      this.voltageBuffer.push(voltage);
      if (this.voltageBuffer.length > this.bufferSize) this.voltageBuffer.shift();
    }
    if (soc >= 0 && soc <= 100) {
      this.socBuffer.push(soc);
      if (this.socBuffer.length > this.bufferSize) this.socBuffer.shift();
    }
  }

  getVoltage(): number | null {
    if (this.voltageBuffer.length === 0) return null;
    return this.voltageBuffer.reduce((a, b) => a + b, 0) / this.voltageBuffer.length;
  }

  getSoc(): number | null {
    if (this.socBuffer.length === 0) return null;
    const sorted = [...this.socBuffer].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  reset(): void {
    this.voltageBuffer = [];
    this.socBuffer = [];
  }
}
