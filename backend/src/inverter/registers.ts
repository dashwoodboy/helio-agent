/**
 * Holding-register maps, carried over from the proven Python implementation.
 *
 * 1-phase hybrid (Sunsynk-style map):
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
 * 3-phase hybrid:
 *   514/515 PV1/PV2 W | 586 battery A (signed, negate) /100 | 587 battery V /100
 *   588 SOC % | 598 grid V /10 | 607 grid W (signed) | 609 grid freq /100 (optional)
 *   644..646 phase V /10 | 650..652 phase loads W | 653 total load W | 667 generator W
 *   540/541 DC/heatsink temp (v-1000)/10
 *   502 daily PV /10 | 520 daily import /10 | 521 daily export /10 | 526 daily load /10
 *   514 is PV — daily battery charge/discharge registers are not reliably
 *   documented for this family, so they stay null on 3-phase.
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
  pvBlock: { start: 514, count: 2 },
  battBlock: { start: 586, count: 3 }, // A, V, SOC
  gridBlock: { start: 598, count: 12 }, // [0] V, [9] W, [11] 609 freq
  phaseBlock: { start: 644, count: 10 }, // 644-646 V, 650-652 loads, 653 total
  generator: 667,
  dcTemp: 540,
  heatsinkTemp: 541,
  dailyPv: 502,
  dailyImport: 520,
  dailyExport: 521,
  dailyLoad: 526,
} as const;

/** Registers used by auto-detection. */
export const DETECT = {
  phaseVoltageL2: 645,
  phaseVoltageL3: 646,
  battV1p: 183,
  battV3p: 587,
  pv2_1p: 187,
  pv2_3p: 515,
  gen1p: 166,
  gen3p: 667,
} as const;
