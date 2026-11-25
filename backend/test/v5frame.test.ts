import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeV5Frame, encodeV5Frame, v5Checksum, V5FrameError } from "../src/solarman/v5frame.js";
import {
  parseReadHoldingRegistersResponse,
  readHoldingRegistersRequest,
} from "../src/solarman/modbus.js";
import { crc16Modbus } from "../src/solarman/crc.js";

interface Fixture {
  serial: number;
  sequence: number;
  slaveId: number;
  startAddr: number;
  quantity: number;
  modbusRequestHex: string;
  v5RequestHex: string;
  v5ResponseHex: string;
  registers: number[];
}

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures/v5_frames.json");
const fixtures: Fixture[] = JSON.parse(readFileSync(fixturesPath, "utf8"));

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("Modbus RTU request builder", () => {
  it("matches umodbus byte-for-byte", () => {
    for (const f of fixtures) {
      const frame = readHoldingRegistersRequest(f.slaveId, f.startAddr, f.quantity);
      expect(toHex(frame)).toBe(f.modbusRequestHex);
    }
  });

  it("computes the Modbus CRC16 correctly", () => {
    // Known vector: 01 03 00 00 00 0A -> CRC 0xCDC5 (LE: c5 cd)
    const crc = crc16Modbus(Uint8Array.from([1, 3, 0, 0, 0, 10]));
    expect(crc & 0xff).toBe(0xc5);
    expect(crc >> 8).toBe(0xcd);
  });
});

describe("V5 frame encoder", () => {
  it("matches pysolarmanv5 byte-for-byte", () => {
    for (const f of fixtures) {
      const encoded = encodeV5Frame(fromHex(f.modbusRequestHex), f.serial, f.sequence);
      expect(toHex(encoded)).toBe(f.v5RequestHex);
    }
  });
});

describe("V5 frame decoder", () => {
  it("decodes logger responses validated by pysolarmanv5", () => {
    for (const f of fixtures) {
      const decoded = decodeV5Frame(fromHex(f.v5ResponseHex), {
        sequenceNumber: f.sequence,
        loggerSerial: f.serial,
      });
      const registers = parseReadHoldingRegistersResponse(decoded.modbusFrame, f.slaveId);
      expect(registers).toEqual(f.registers);
    }
  });

  it("rejects a corrupted checksum", () => {
    const f = fixtures[0];
    const frame = fromHex(f.v5ResponseHex);
    frame[frame.length - 2] ^= 0xff;
    expect(() =>
      decodeV5Frame(frame, { sequenceNumber: f.sequence, loggerSerial: f.serial }),
    ).toThrow(V5FrameError);
  });

  it("rejects a mismatched sequence number", () => {
    const f = fixtures[0];
    expect(() =>
      decodeV5Frame(fromHex(f.v5ResponseHex), {
        sequenceNumber: f.sequence + 1,
        loggerSerial: f.serial,
      }),
    ).toThrow(/sequence/);
  });

  it("rejects a mismatched logger serial", () => {
    const f = fixtures[0];
    expect(() =>
      decodeV5Frame(fromHex(f.v5ResponseHex), {
        sequenceNumber: f.sequence,
        loggerSerial: f.serial + 1,
      }),
    ).toThrow(/serial/);
  });

  it("round-trips checksum calculation", () => {
    const f = fixtures[1];
    const frame = fromHex(f.v5RequestHex);
    expect(frame[frame.length - 2]).toBe(v5Checksum(frame));
  });
});
