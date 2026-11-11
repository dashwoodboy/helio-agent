/**
 * UDP spike: find out whether the stick's "Server A/B" UDP mode actually
 * pushes Solarman V5 frames (plain, no TLS) when the protocol is set to UDP.
 *
 * Listens on a UDP port, hex-dumps every datagram, ACKs logger-initiated
 * frames (handshake 0x4110, data 0x4210, wifi 0x4310, heartbeat 0x4710)
 * back to the sender, and once a serial is known periodically issues a
 * read-holding-registers request (0x4510) to the stick's source address
 * to prove server-initiated reads work over UDP too.
 *
 * Usage:
 *   npx tsx scripts/udp-spike.ts [--port 10000] [--read-reg 79] [--out udp-spike-fixtures.jsonl]
 *
 * On the stick's config_hide page set Server A (or B) to:
 *   protocol UDP, IP of this machine, this port.
 * Captured datagrams are appended to the --out file (JSON lines).
 */
import dgram from "node:dgram";
import os from "node:os";
import fs from "node:fs";
import {
  encodeLoggerAckFrame,
  encodeV5Frame,
  LOGGER_PUSH_CONTROL_CODES,
  parseFrameHeader,
  V5_CONTROL_RESPONSE,
  validateFrameEnvelope,
} from "../src/solarman/v5frame.js";
import { readHoldingRegistersRequest, parseReadHoldingRegistersResponse } from "../src/solarman/modbus.js";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const PORT = Number(arg("port", "10000"));
const READ_REG = Number(arg("read-reg", "79")); // grid frequency on 1-phase models
const OUT = arg("out", "udp-spike-fixtures.jsonl");

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

function record(direction: "in" | "out", data: Uint8Array, note: string, peer: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    direction,
    peer,
    note,
    hex: Buffer.from(data).toString("hex"),
  });
  fs.appendFileSync(OUT, line + "\n");
}

const socket = dgram.createSocket("udp4");

let serial: number | null = null;
let seq = 1;
let lastPeer: { address: string; port: number } | null = null;
let readTimer: NodeJS.Timeout | null = null;

function send(data: Uint8Array, note: string): void {
  if (!lastPeer) return;
  const peer = `${lastPeer.address}:${lastPeer.port}`;
  console.log(`>> ${note}: ${hex(data)}`);
  record("out", data, note, peer);
  socket.send(data, lastPeer.port, lastPeer.address);
}

function tryServerRead(): void {
  if (serial === null) return;
  seq = (seq + 1) & 0xff || 1;
  const mb = readHoldingRegistersRequest(1, READ_REG, 1);
  send(encodeV5Frame(mb, serial, seq), `server 0x4510 read reg ${READ_REG} (seq ${seq})`);
}

socket.on("message", (msg, rinfo) => {
  const peer = `${rinfo.address}:${rinfo.port}`;
  lastPeer = { address: rinfo.address, port: rinfo.port };

  // A UDP datagram should carry exactly one V5 frame; log whatever arrives.
  let header;
  try {
    header = parseFrameHeader(msg);
  } catch {
    console.log(`<< ${peer} non-V5 datagram (${msg.length} bytes): ${hex(msg)}`);
    record("in", msg, "non-V5 datagram", peer);
    return;
  }
  const ok = validateFrameEnvelope(msg);
  const code = `0x${header.controlCode.toString(16).padStart(4, "0")}`;
  console.log(
    `<< ${peer} ${code} serial=${header.loggerSerial} seq=${header.sequence} ` +
      `type=${header.frameType} len=${msg.length} checksum=${ok ? "ok" : "BAD"}`,
  );
  console.log(`   ${hex(msg)}`);
  record("in", msg, `control ${code}`, peer);

  if (header.loggerSerial > 0) serial = header.loggerSerial;

  if (LOGGER_PUSH_CONTROL_CODES.has(header.controlCode)) {
    send(encodeLoggerAckFrame(msg), `ack ${code}`);
    if (!readTimer) {
      readTimer = setInterval(tryServerRead, 15000);
      setTimeout(tryServerRead, 3000);
    }
  } else if (header.controlCode === V5_CONTROL_RESPONSE) {
    const modbus = msg.subarray(25, msg.length - 2);
    try {
      const values = parseReadHoldingRegistersResponse(modbus, 1);
      console.log(`   SERVER READ OK — reg ${READ_REG} = ${values[0]}`);
      record("in", msg, `0x1510 response, reg ${READ_REG} = ${values[0]}`, peer);
    } catch (err) {
      console.log(`   0x1510 response but Modbus parse failed: ${(err as Error).message}`);
    }
  }
});

socket.on("error", (err) => console.log(`socket error: ${err.message}`));

socket.bind(PORT, () => {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  console.log(`UDP spike listening on :${PORT}`);
  console.log(`This machine's LAN IPs: ${addrs.join(", ") || "(none found)"}`);
  console.log(`Fixtures will be appended to ${OUT}`);
  console.log(`On config_hide set Server A/B to: UDP, <one of the IPs above>, port ${PORT}.`);
});
