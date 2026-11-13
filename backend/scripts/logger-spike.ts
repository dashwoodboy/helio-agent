/**
 * Phase-0 spike: validate the Solarman stick's "Server B" / optional-server
 * mode against real hardware.
 *
 * Listens on a TCP port, hex-dumps every frame the stick sends, ACKs the
 * logger-initiated frames (handshake 0x4110, data 0x4210, wifi 0x4310,
 * heartbeat 0x4710) and, once a serial is known, periodically issues a
 * read-holding-registers request (0x4510) over the same connection to prove
 * the stick answers server-initiated Modbus reads.
 *
 * Usage:
 *   npx tsx scripts/logger-spike.ts [--port 10000] [--read-reg 79] [--out fixtures.jsonl]
 *
 * Point the stick's web page (http://<stick-ip>, usually admin/admin) at
 * this machine: "Server B" or "Optional server" -> this host + port, TCP.
 * Captured frames are appended to the --out file (JSON lines) so they can
 * be checked in as test fixtures.
 */
import net from "node:net";
import fs from "node:fs";
import {
  encodeLoggerAckFrame,
  encodeV5Frame,
  extractV5Frames,
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
const OUT = arg("out", "logger-spike-fixtures.jsonl");

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

function record(direction: "in" | "out", frame: Uint8Array, note: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    direction,
    note,
    hex: Buffer.from(frame).toString("hex"),
  });
  fs.appendFileSync(OUT, line + "\n");
}

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n=== Connection from ${peer} ===`);
  let buffer: Buffer = Buffer.alloc(0);
  let serial: number | null = null;
  let seq = 1;
  let readTimer: NodeJS.Timeout | null = null;

  const tryServerRead = () => {
    if (serial === null) return;
    seq = (seq + 1) & 0xff || 1;
    const mb = readHoldingRegistersRequest(1, READ_REG, 1);
    const req = encodeV5Frame(mb, serial, seq);
    console.log(`>> server 0x4510 read reg ${READ_REG} (seq ${seq}): ${hex(req)}`);
    record("out", req, `server read reg ${READ_REG} seq ${seq}`);
    socket.write(req);
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = extractV5Frames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const ok = validateFrameEnvelope(frame);
      let header;
      try {
        header = parseFrameHeader(frame);
      } catch {
        console.log(`<< unparseable frame: ${hex(frame)}`);
        record("in", frame, "unparseable");
        continue;
      }
      const code = `0x${header.controlCode.toString(16).padStart(4, "0")}`;
      console.log(
        `<< ${code} serial=${header.loggerSerial} seq=${header.sequence} ` +
          `type=${header.frameType} len=${frame.length} checksum=${ok ? "ok" : "BAD"}`,
      );
      console.log(`   ${hex(frame)}`);
      record("in", frame, `control ${code}`);

      if (header.loggerSerial > 0) serial = header.loggerSerial;

      if (LOGGER_PUSH_CONTROL_CODES.has(header.controlCode)) {
        const ack = encodeLoggerAckFrame(frame);
        console.log(`>> ack ${code}: ${hex(ack)}`);
        record("out", ack, `ack for ${code}`);
        socket.write(ack);
        // After the first handshake/heartbeat, start probing server-side reads.
        if (!readTimer) {
          readTimer = setInterval(tryServerRead, 15000);
          setTimeout(tryServerRead, 3000);
        }
      } else if (header.controlCode === V5_CONTROL_RESPONSE) {
        // Response to our 0x4510 read.
        const modbus = frame.subarray(25, frame.length - 2);
        try {
          const values = parseReadHoldingRegistersResponse(modbus, 1);
          console.log(`   SERVER READ OK — reg ${READ_REG} = ${values[0]}`);
          record("in", frame, `0x1510 response, reg ${READ_REG} = ${values[0]}`);
        } catch (err) {
          console.log(`   0x1510 response but Modbus parse failed: ${(err as Error).message}`);
        }
      }
    }
  });

  socket.on("close", () => {
    if (readTimer) clearInterval(readTimer);
    console.log(`=== ${peer} disconnected ===`);
  });
  socket.on("error", (err) => console.log(`socket error: ${err.message}`));
});

server.listen(PORT, () => {
  console.log(`Logger spike listening on :${PORT}`);
  console.log(`Fixtures will be appended to ${OUT}`);
  console.log(`Point the stick's "Server B" / optional server at this host, port ${PORT}, TCP.`);
});
