import { describe, expect, it } from "vitest";
import {
  ModbusError,
  parseWriteMultipleRegistersResponse,
  parseWriteSingleRegisterResponse,
  writeMultipleRegistersRequest,
  writeSingleRegisterRequest,
} from "../src/solarman/modbus.js";
import { withCrc } from "../src/solarman/crc.js";

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("write single register (0x06)", () => {
  it("builds the request byte-for-byte", () => {
    const frame = writeSingleRegisterRequest(1, 243, 1);
    expect(toHex(frame.subarray(0, 6))).toBe("010600f30001");
    // CRC must validate round-trip
    expect(toHex(withCrc(frame.subarray(0, 6)))).toBe(toHex(frame));
  });

  it("accepts an echo response", () => {
    const req = writeSingleRegisterRequest(1, 245, 3000);
    // A 0x06 response is an exact echo of the request.
    expect(() => parseWriteSingleRegisterResponse(req, 1, 245, 3000)).not.toThrow();
  });

  it("rejects a wrong echoed value", () => {
    const resp = writeSingleRegisterRequest(1, 245, 2999);
    expect(() => parseWriteSingleRegisterResponse(resp, 1, 245, 3000)).toThrow(/wrong value/);
  });

  it("rejects a wrong echoed address", () => {
    const resp = writeSingleRegisterRequest(1, 244, 3000);
    expect(() => parseWriteSingleRegisterResponse(resp, 1, 245, 3000)).toThrow(/wrong address/);
  });

  it("surfaces Modbus exception 0x86 with the code", () => {
    const resp = withCrc(new Uint8Array([1, 0x86, 0x02]));
    expect(() => parseWriteSingleRegisterResponse(resp, 1, 245, 3000)).toThrow(
      /exception code 2 \(illegal data address\)/,
    );
  });

  it("rejects a corrupted CRC", () => {
    const resp = writeSingleRegisterRequest(1, 245, 3000);
    resp[resp.length - 1] ^= 0xff;
    expect(() => parseWriteSingleRegisterResponse(resp, 1, 245, 3000)).toThrow(ModbusError);
  });

  it("rejects a mismatched slave id", () => {
    const resp = writeSingleRegisterRequest(2, 245, 3000);
    expect(() => parseWriteSingleRegisterResponse(resp, 1, 245, 3000)).toThrow(/slave id/);
  });
});

describe("write multiple registers (0x10)", () => {
  it("builds the request with byte count and payload", () => {
    const frame = writeMultipleRegistersRequest(1, 22, [0x1911, 0x0a0c, 0x1e00]);
    const body = frame.subarray(0, frame.length - 2);
    expect(toHex(body)).toBe("011000160003061911" + "0a0c" + "1e00");
    expect(toHex(withCrc(body))).toBe(toHex(frame));
  });

  it("accepts a well-formed response", () => {
    // Response: slave, 0x10, addr hi/lo, quantity hi/lo
    const resp = withCrc(new Uint8Array([1, 0x10, 0x00, 0x16, 0x00, 0x03]));
    expect(() => parseWriteMultipleRegistersResponse(resp, 1, 22, 3)).not.toThrow();
  });

  it("rejects a wrong echoed quantity", () => {
    const resp = withCrc(new Uint8Array([1, 0x10, 0x00, 0x16, 0x00, 0x02]));
    expect(() => parseWriteMultipleRegistersResponse(resp, 1, 22, 3)).toThrow(/wrong quantity/);
  });

  it("surfaces Modbus exception 0x90 with the code", () => {
    const resp = withCrc(new Uint8Array([1, 0x90, 0x03]));
    expect(() => parseWriteMultipleRegistersResponse(resp, 1, 22, 3)).toThrow(
      /exception code 3 \(illegal data value\)/,
    );
  });
});
