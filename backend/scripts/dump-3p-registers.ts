/**
 * 3-phase register dump: connect to the stick's local TCP port and print the
 * raw and interpreted values of every register the 3-phase reader uses, plus
 * device-type detection (LV SG04LP3 vs HV SG01HP3). For sharing in bug
 * reports when a three-phase installation shows implausible numbers.
 *
 * Usage: npx tsx scripts/dump-3p-registers.ts [--ip 192.168.1.100] [--serial 1134055009] [--port 8899]
 */
import { SolarmanClient } from "../src/solarman/client.js";
import { toSigned } from "../src/solarman/modbus.js";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const IP = arg("ip", "192.168.1.100");
const SERIAL = Number(arg("serial", "1134055009"));
const PORT = Number(arg("port", "8899"));

const client = new SolarmanClient({ address: IP, serial: SERIAL, port: PORT });

async function block(start: number, count: number): Promise<number[]> {
  return client.readHoldingRegisters(start, count);
}

console.log(`Dumping 3-phase registers from ${IP}:${PORT} (serial ${SERIAL})…\n`);

// --- device type ---------------------------------------------------------
const [deviceType] = await block(0, 1);
const family =
  (deviceType & 0xff00) === 0x0600 ? "3-phase HV (SG01HP3 family)"
  : (deviceType & 0xff00) === 0x0500 ? "3-phase LV (SG04LP3 family)"
  : (deviceType & 0xff00) === 0x0300 ? "1-phase hybrid (SG04LP1 family)"
  : "unknown";
const hv = (deviceType & 0xff00) === 0x0600;
console.log(`reg 0   device type       raw=0x${deviceType.toString(16).padStart(4, "0")}  → ${family}`);

const pvScale = hv ? 10 : 1;
const battVScale = hv ? 10 : 100;

// --- dailies + totals (514-535) ------------------------------------------
const daily = await block(514, 22);
const d = (reg: number) => daily[reg - 514];
console.log(`\n--- daily counters (0.1 kWh) ---`);
console.log(`reg 514 batt charge today raw=${d(514)}  → ${d(514) / 10} kWh`);
console.log(`reg 515 batt dischg today raw=${d(515)}  → ${d(515) / 10} kWh`);
console.log(`reg 520 grid import today raw=${d(520)}  → ${d(520) / 10} kWh`);
console.log(`reg 521 grid export today raw=${d(521)}  → ${d(521) / 10} kWh`);
console.log(`reg 526 load today        raw=${d(526)}  → ${d(526) / 10} kWh`);
console.log(`reg 529 PV today          raw=${d(529)}  → ${d(529) / 10} kWh`);
const totalPv = (d(534) + d(535) * 65536) / 10;
console.log(`reg 534/535 PV total      raw=${d(534)}/${d(535)}  → ${totalPv} kWh`);

// --- temperatures ---------------------------------------------------------
const temps = await block(540, 2);
console.log(`\n--- temperatures ((raw-1000)/10 °C) ---`);
console.log(`reg 540 DC temp           raw=${temps[0]}  → ${(temps[0] - 1000) / 10} °C`);
console.log(`reg 541 heatsink temp     raw=${temps[1]}  → ${(temps[1] - 1000) / 10} °C`);

// --- battery (587-591) ----------------------------------------------------
const batt = await block(587, 5);
console.log(`\n--- battery ---`);
console.log(`reg 587 battery V         raw=${batt[0]}  → ${batt[0] / battVScale} V`);
console.log(`reg 588 battery SOC       raw=${batt[1]}  → ${batt[1]} %`);
console.log(`reg 590 battery W         raw=${batt[3]}  → ${-toSigned(batt[3]) * (hv ? 10 : 1)} W (+ = charging)`);
console.log(`reg 591 battery A         raw=${batt[4]}  → ${-toSigned(batt[4]) / 100} A (+ = charging)`);

// --- grid (598-625) -------------------------------------------------------
const grid = await block(598, 28);
const g = (reg: number) => grid[reg - 598];
console.log(`\n--- grid ---`);
console.log(`reg 598 grid V L1         raw=${g(598)}  → ${g(598) / 10} V`);
console.log(`reg 599 grid V L2         raw=${g(599)}  → ${g(599) / 10} V`);
console.log(`reg 600 grid V L3         raw=${g(600)}  → ${g(600) / 10} V`);
console.log(`reg 609 grid frequency    raw=${g(609)}  → ${g(609) / 100} Hz`);
console.log(`reg 625 grid total W      raw=${g(625)}  → ${toSigned(g(625))} W (+ = importing)`);

// --- loads (644-653) ------------------------------------------------------
const load = await block(644, 10);
const l = (reg: number) => load[reg - 644];
console.log(`\n--- loads ---`);
console.log(`reg 644 load V L1         raw=${l(644)}  → ${l(644) / 10} V`);
console.log(`reg 645 load V L2         raw=${l(645)}  → ${l(645) / 10} V`);
console.log(`reg 646 load V L3         raw=${l(646)}  → ${l(646) / 10} V`);
console.log(`reg 650 load W L1         raw=${l(650)}  → ${toSigned(l(650))} W`);
console.log(`reg 651 load W L2         raw=${l(651)}  → ${toSigned(l(651))} W`);
console.log(`reg 652 load W L3         raw=${l(652)}  → ${toSigned(l(652))} W`);
console.log(`reg 653 load W total      raw=${l(653)}  → ${toSigned(l(653))} W`);

// --- generator + PV -------------------------------------------------------
const [gen] = await block(667, 1);
console.log(`\nreg 667 generator W       raw=${gen}  → ${toSigned(gen)} W`);

const pv = await block(672, 2);
console.log(`reg 672 PV1 W             raw=${pv[0]}  → ${pv[0] * pvScale} W`);
console.log(`reg 673 PV2 W             raw=${pv[1]}  → ${pv[1] * pvScale} W`);

await client.disconnect();
