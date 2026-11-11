/**
 * One-shot direct LAN poll: connect to the stick's local TCP port, detect
 * capabilities and print one live reading. Proves "direct" mode end to end.
 *
 * Usage: npx tsx scripts/direct-poll-test.ts [--ip 192.168.1.100] [--serial 1134055009] [--port 8899]
 */
import { SolarmanClient } from "../src/solarman/client.js";
import { DeyeInverter } from "../src/inverter/reader.js";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const IP = arg("ip", "192.168.1.100");
const SERIAL = Number(arg("serial", "1134055009"));
const PORT = Number(arg("port", "8899"));

const client = new SolarmanClient({ address: IP, serial: SERIAL, port: PORT });
const inv = new DeyeInverter(client, {});

console.log(`Polling ${IP}:${PORT} (serial ${SERIAL})…`);
const cfg = await inv.detectConfig();
console.log("config detectada:", JSON.stringify(cfg));
const live = await inv.readLive(cfg);
console.log("leitura live:", JSON.stringify(live, null, 2));
await client.disconnect();
