/**
 * Fake Solarman stick: connects to the logger gateway the way a real stick
 * in "Server B" mode does — sends a handshake and heartbeats, and answers
 * 0x4510 requests from a register bank fed by the built-in inverter
 * simulator (1-phase map by default, 3-phase with --phases 3 [--hv]).
 * Reads (0x03) merge live simulator values over a mutable settings bank;
 * writes (0x06/0x10) mutate that bank like a real inverter storing settings.
 *
 * Standalone: npx tsx scripts/fake-logger.ts [--host 127.0.0.1] [--port 10000] [--serial 2712345678] [--phases 3] [--hv]
 * Also imported by the gateway tests.
 */
import net from "node:net";
import tls from "node:tls";
import {
  extractV5Frames,
  parseFrameHeader,
  v5Checksum,
  V5_CONTROL_HANDSHAKE,
  V5_CONTROL_HEARTBEAT,
  V5_CONTROL_REQUEST,
  V5_END,
  V5_START,
} from "../src/solarman/v5frame.js";
import { withCrc, checkCrc } from "../src/solarman/crc.js";
import { SimulatedInverter } from "../src/inverter/simulator.js";
import { defaultSimulatedRegisters } from "../src/inverter/control.js";
import { registersFrom1p, registersFrom3p } from "../src/inverter/registerImage.js";

/** Back-compat alias: the 1-phase register image now lives in registerImage.ts. */
export const registersFrom = registersFrom1p;

function buildHandshakeFrame(serial: number): Uint8Array {
  // Minimal logger push frame: handshake control code + empty-ish payload.
  const payload = new Uint8Array(1); // frame type placeholder content
  const frame = new Uint8Array(11 + 1 + payload.length + 2);
  const view = new DataView(frame.buffer);
  frame[0] = V5_START;
  view.setUint16(1, frame.length - 13, true);
  view.setUint16(3, V5_CONTROL_HANDSHAKE, true);
  view.setUint16(5, 1, true);
  view.setUint32(7, serial >>> 0, true);
  frame[11] = 0x02;
  frame[frame.length - 2] = v5Checksum(frame);
  frame[frame.length - 1] = V5_END;
  return frame;
}

function buildHeartbeatFrame(serial: number, seq: number): Uint8Array {
  const frame = new Uint8Array(11 + 2 + 2);
  const view = new DataView(frame.buffer);
  frame[0] = V5_START;
  view.setUint16(1, frame.length - 13, true);
  view.setUint16(3, V5_CONTROL_HEARTBEAT, true);
  view.setUint16(5, seq & 0xff, true);
  view.setUint32(7, serial >>> 0, true);
  frame[11] = 0x01;
  frame[frame.length - 2] = v5Checksum(frame);
  frame[frame.length - 1] = V5_END;
  return frame;
}

/** V5 response frame (0x1510) carrying a Modbus RTU frame, as a stick builds it. */
export function buildResponseFrame(modbus: Uint8Array, serial: number, seqByte: number): Uint8Array {
  const frame = new Uint8Array(25 + modbus.length + 2);
  const view = new DataView(frame.buffer);
  frame[0] = V5_START;
  view.setUint16(1, frame.length - 13, true);
  view.setUint16(3, 0x1510, true);
  frame[5] = seqByte & 0xff;
  frame[6] = 0x00;
  view.setUint32(7, serial >>> 0, true);
  frame[11] = 0x02;
  // bytes 12..24: sensor type + time fields, zeroed
  frame.set(modbus, 25);
  frame[frame.length - 2] = v5Checksum(frame);
  frame[frame.length - 1] = V5_END;
  return frame;
}

export interface FakeLoggerOptions {
  host: string;
  port: number;
  serial: number;
  /** Registers the stick cannot read (to exercise optional-register paths). */
  unavailableRegisters?: Set<number>;
  heartbeatMs?: number;
  /** Wrap the connection in TLS, like newer LSW5 firmwares do. */
  tls?: boolean;
  /** Simulate a 3-phase hybrid (registers 500-730 family). */
  phases?: 1 | 3;
  /** With phases 3: high-voltage battery model (SG01HP3 scales). */
  hv?: boolean;
  log?: (msg: string) => void;
}

export interface FakeLoggerHandle {
  stop: () => void;
  socket: net.Socket;
  /** Mutable settings register bank (written to by 0x06/0x10 requests). */
  registers: Map<number, number>;
}

/** Connect to a gateway and behave like a stick until stopped. */
export function startFakeLogger(opts: FakeLoggerOptions): Promise<FakeLoggerHandle> {
  const log = opts.log ?? (() => undefined);
  const phases = opts.phases ?? 1;
  const simulator = new SimulatedInverter({ kwp: 5.5, batteryCapacityKwh: 16, phases });
  const simConfig = { phases, hasBattery: true, pvStrings: 2 as const, hasGenerator: false };
  const buildImage = (full: Parameters<typeof registersFrom1p>[0]) =>
    phases === 3 ? registersFrom3p(full, { hv: opts.hv }) : registersFrom1p(full);
  const unavailable = opts.unavailableRegisters ?? new Set<number>();
  // Writable settings registers, like the real inverter's flash-backed bank.
  const settingsBank = defaultSimulatedRegisters();

  return new Promise((resolve, reject) => {
    const socket = opts.tls
      ? tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: false })
      : net.createConnection({ host: opts.host, port: opts.port });
    let buffer: Buffer = Buffer.alloc(0);
    let heartbeat: NodeJS.Timeout | null = null;
    let seq = 1;

    const stop = () => {
      if (heartbeat) clearInterval(heartbeat);
      socket.destroy();
    };

    socket.once("error", (err) => reject(err));
    socket.on(opts.tls ? "secureConnect" : "connect", () => {
      socket.setNoDelay(true);
      socket.write(buildHandshakeFrame(opts.serial));
      heartbeat = setInterval(() => {
        seq = (seq + 1) & 0xff || 1;
        if (!socket.destroyed) socket.write(buildHeartbeatFrame(opts.serial, seq));
      }, opts.heartbeatMs ?? 30000);
      resolve({ stop, socket, registers: settingsBank });
    });

    socket.on("data", (chunk) => {
      void (async () => {
        buffer = Buffer.concat([buffer, chunk]);
        const { frames, rest } = extractV5Frames(buffer);
        buffer = rest;
        for (const frame of frames) {
          let header;
          try {
            header = parseFrameHeader(frame);
          } catch {
            continue;
          }
          if (header.controlCode !== V5_CONTROL_REQUEST) continue; // ACKs etc.

          const modbusReq = frame.subarray(26, frame.length - 2);
          const body = checkCrc(modbusReq);
          if (!body) continue;
          const fn = body[1];
          const start = (body[2] << 8) | body[3];

          let response: Uint8Array;
          if (fn === 0x03) {
            const quantity = (body[4] << 8) | body[5];
            log(`read ${start}+${quantity}`);
            const blocked = [...Array(quantity).keys()].some((i) => unavailable.has(start + i));
            // Live registers come from the simulator, settings from the bank.
            const live = buildImage(await simulator.readFull(simConfig));
            const lookup = (addr: number) => live.get(addr) ?? settingsBank.get(addr);
            const known = [...Array(quantity).keys()].some((i) => lookup(start + i) !== undefined);
            if (blocked || !known) {
              response = withCrc(new Uint8Array([1, 0x83, 0x02])); // illegal data address
            } else {
              const pdu = new Uint8Array(3 + quantity * 2);
              pdu[0] = 1;
              pdu[1] = 0x03;
              pdu[2] = quantity * 2;
              for (let i = 0; i < quantity; i++) {
                const v = lookup(start + i) ?? 0;
                pdu[3 + i * 2] = (v >> 8) & 0xff;
                pdu[4 + i * 2] = v & 0xff;
              }
              response = withCrc(pdu);
            }
          } else if (fn === 0x06) {
            const value = (body[4] << 8) | body[5];
            log(`write ${start}=${value}`);
            if (unavailable.has(start) || !settingsBank.has(start)) {
              response = withCrc(new Uint8Array([1, 0x86, 0x02]));
            } else {
              settingsBank.set(start, value);
              response = withCrc(body); // 0x06 responses echo the request
            }
          } else if (fn === 0x10) {
            const quantity = (body[4] << 8) | body[5];
            log(`write ${start}+${quantity}`);
            const blocked = [...Array(quantity).keys()].some(
              (i) => unavailable.has(start + i) || !settingsBank.has(start + i),
            );
            if (blocked || body.length < 7 + quantity * 2) {
              response = withCrc(new Uint8Array([1, 0x90, 0x02]));
            } else {
              for (let i = 0; i < quantity; i++) {
                settingsBank.set(start + i, (body[7 + i * 2] << 8) | body[8 + i * 2]);
              }
              response = withCrc(body.subarray(0, 6)); // addr + quantity echo
            }
          } else {
            continue;
          }
          if (!socket.destroyed) {
            socket.write(buildResponseFrame(response, opts.serial, frame[5]));
          }
        }
      })();
    });
  });
}

// ------------------------------------------------------------- CLI entry

const isMain = process.argv[1]?.endsWith("fake-logger.ts");
if (isMain) {
  const arg = (name: string, fallback: string): string => {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
  };
  const host = arg("host", "127.0.0.1");
  const port = Number(arg("port", "10000"));
  const serial = Number(arg("serial", "2712345678"));
  const phases = Number(arg("phases", "1")) === 3 ? (3 as const) : (1 as const);
  const hv = process.argv.includes("--hv");
  console.log(
    `Fake logger ${serial} (${phases}-phase${hv ? ", HV" : ""}) connecting to ${host}:${port}...`,
  );
  startFakeLogger({ host, port, serial, heartbeatMs: 10000, phases, hv, log: console.log })
    .then(({ socket }) => {
      console.log("Connected. Ctrl+C to stop.");
      socket.on("close", () => {
        console.log("Disconnected.");
        process.exit(0);
      });
    })
    .catch((err) => {
      console.error(`Failed to connect: ${err.message}`);
      process.exit(1);
    });
}
