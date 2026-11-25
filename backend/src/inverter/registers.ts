/**
 * Holding-register maps.
 *
 * 1-phase hybrid (Sunsynk-style map, carried over from the proven Python
 * implementation):
 *   150 grid voltage /10 | 166 generator W | 169 grid W (signed)
 *   176 load L1 W | 178 total load W | 183 battery V /100 | 184 SOC %
 *   186/187 PV1/PV2 W | 191 battery A (signed, negate) /100
 *   90/91 DC/heatsink temp (v-1000)/10
 *   108 daily PV /10 | 76 daily import /10 | 77 daily export /10 | 84 daily load /10
 *   70/71 daily battery charge/discharge /10 (optional)
 *   79 grid frequency /100 (optional) | 96..97 total PV kWh /10 32-bit, low word
 *   first (optional)
 *   107 battery capacity Ah | 236 nominal V /100
 *
 * 3-phase hybrid (SG04LP3 low-voltage / SG01HP3 high-voltage), from Deye's
 * three-phase energy-storage protocol (cross-checked against the
 * deye-inverter-mqtt and Modbus Connect register maps):
 *   672/673 PV1/PV2 W (HV: x10) | 587 battery V /100 (HV: /10) | 588 SOC %
 *   591 battery A (signed, negate) /100 | 586 is the battery TEMPERATURE
 *   598..600 grid phase V /10 | 609 grid freq /100 | 625 grid total W
 *   (signed, + importing); 607 is the inner-side power — NOT the grid total
 *   650..652 phase loads W | 653 total load W | 667 generator W
 *   540/541 DC/heatsink temp (v-1000)/10
 *   529 daily PV /10 | 520 daily import /10 | 521 daily export /10
 *   526 daily load /10 | 514/515 daily battery charge/discharge /10
 *   534..535 total PV kWh /10 32-bit, low word first
 *   Register 0 tells the families apart: 0x03xx 1-phase, 0x05xx 3-phase LV,
 *   0x06xx 3-phase HV (battery V /10 and PV W x10).
 */

export const REG_1P = {
  gridV: 150,
  liveBlockA: { start: 166, count: 13 }, // 166 gen, 169 gridW, 176 L1, 178 load
  liveBlockB: { start: 183, count: 9 }, // 183 battV, 184 soc, 186/187 pv, 191 battA
  dcTemp: 90,
  heatsinkTemp: 91,
  dailyPv: 108,
  dailyImport: 76,
  dailyExport: 77,
  dailyLoad: 84,
  dailyBattBlock: { start: 70, count: 2 }, // 70 charge, 71 discharge (optional)
  gridHz: 79, // optional
  totalPvBlock: { start: 96, count: 2 }, // optional 32-bit (low word first), /10 kWh
  batteryCapacityAh: 107,
  batteryNominalV: 236,
} as const;

export const REG_3P = {
  pvBlock: { start: 672, count: 2 }, // PV1/PV2 power (HV: x10 W)
  battBlock: { start: 587, count: 5 }, // 587 V, 588 SOC, [591] A (signed, negate)
  gridBlock: { start: 598, count: 12 }, // 598-600 phase V, [11] 609 freq
  gridPower: 625, // grid total W (signed, + importing)
  phaseBlock: { start: 644, count: 10 }, // 650-652 loads, 653 total
  generator: 667,
  dcTemp: 540,
  heatsinkTemp: 541,
  dailyBlock: { start: 514, count: 16 }, // 514/515 batt chg/dis, 520 imp, 521 exp, 526 load, 529 PV
  totalPvBlock: { start: 534, count: 2 }, // 32-bit /10 kWh, low word first
} as const;

/** Registers used by auto-detection. */
export const DETECT = {
  deviceType: 0, // 0x03xx = 1-phase, 0x05xx = 3-phase LV, 0x06xx = 3-phase HV
  phaseVoltageL2: 645,
  phaseVoltageL3: 646,
  battV1p: 183,
  battV3p: 587,
  pv2_1p: 187,
  pv2_3p: 673,
  gen1p: 166,
  gen3p: 667,
} as const;
