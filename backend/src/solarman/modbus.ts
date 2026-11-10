import { checkCrc, withCrc } from "./crc.js";

export class ModbusError extends Error {}

/** Build a Modbus RTU "read holding registers" (function 0x03) request. */
export function readHoldingRegistersRequest(
  slaveId: number,
  startAddr: number,
  quantity: number,
): Uint8Array {
  const pdu = new Uint8Array(6);
  pdu[0] = slaveId;
  pdu[1] = 0x03;
  pdu[2] = (startAddr >> 8) & 0xff;
  pdu[3] = startAddr & 0xff;
  pdu[4] = (quantity >> 8) & 0xff;
  pdu[5] = quantity & 0xff;
  return withCrc(pdu);
}

/** Parse a Modbus RTU function 0x03 response into register values. */
export function parseReadHoldingRegistersResponse(
  frame: Uint8Array,
  expectedSlaveId: number,
): number[] {
  const body = checkCrc(frame);
  if (!body) throw new ModbusError("Invalid Modbus CRC");
  if (body.length < 2) throw new ModbusError("Modbus response too short");
  if (body[0] !== expectedSlaveId) {
    throw new ModbusError(`Unexpected slave id ${body[0]}`);
  }
  if (body[1] === 0x83) {
    throw new ModbusError(`Modbus exception code ${body[2]}`);
  }
  if (body[1] !== 0x03) {
    throw new ModbusError(`Unexpected function code ${body[1]}`);
  }
  const byteCount = body[2];
  if (body.length < 3 + byteCount) {
    throw new ModbusError("Modbus response truncated");
  }
  const values: number[] = [];
  for (let i = 0; i < byteCount; i += 2) {
    values.push((body[3 + i] << 8) | body[4 + i]);
  }
  return values;
}

/** Convert an unsigned 16-bit register value to signed. */
export function toSigned(value: number): number {
  return value >= 0x8000 ? value - 0x10000 : value;
}

// ------------------------------------------------------------------ writes

/** Build a Modbus RTU "write single register" (function 0x06) request. */
export function writeSingleRegisterRequest(
  slaveId: number,
  addr: number,
  value: number,
): Uint8Array {
  const pdu = new Uint8Array(6);
  pdu[0] = slaveId;
  pdu[1] = 0x06;
  pdu[2] = (addr >> 8) & 0xff;
  pdu[3] = addr & 0xff;
  pdu[4] = (value >> 8) & 0xff;
  pdu[5] = value & 0xff;
  return withCrc(pdu);
}

/** Build a Modbus RTU "write multiple registers" (function 0x10) request. */
export function writeMultipleRegistersRequest(
  slaveId: number,
  startAddr: number,
  values: number[],
): Uint8Array {
  const pdu = new Uint8Array(7 + values.length * 2);
  pdu[0] = slaveId;
  pdu[1] = 0x10;
  pdu[2] = (startAddr >> 8) & 0xff;
  pdu[3] = startAddr & 0xff;
  pdu[4] = (values.length >> 8) & 0xff;
  pdu[5] = values.length & 0xff;
  pdu[6] = values.length * 2;
  values.forEach((v, i) => {
    pdu[7 + i * 2] = (v >> 8) & 0xff;
    pdu[8 + i * 2] = v & 0xff;
  });
  return withCrc(pdu);
}

const EXCEPTION_MESSAGES: Record<number, string> = {
  1: "illegal function",
  2: "illegal data address",
  3: "illegal data value",
  4: "slave device failure",
};

function checkWriteResponse(
  frame: Uint8Array,
  expectedSlaveId: number,
  expectedFunction: 0x06 | 0x10,
): Uint8Array {
  const body = checkCrc(frame);
  if (!body) throw new ModbusError("Invalid Modbus CRC");
  if (body.length < 2) throw new ModbusError("Modbus response too short");
  if (body[0] !== expectedSlaveId) {
    throw new ModbusError(`Unexpected slave id ${body[0]}`);
  }
  if (body[1] === (expectedFunction | 0x80)) {
    const code = body[2];
    const detail = EXCEPTION_MESSAGES[code] ?? "unknown";
    throw new ModbusError(`Modbus exception code ${code} (${detail})`);
  }
  if (body[1] !== expectedFunction) {
    throw new ModbusError(`Unexpected function code ${body[1]}`);
  }
  if (body.length < 6) throw new ModbusError("Modbus response truncated");
  return body;
}

/** Parse a function 0x06 response, verifying the echoed address and value. */
export function parseWriteSingleRegisterResponse(
  frame: Uint8Array,
  expectedSlaveId: number,
  expectedAddr: number,
  expectedValue: number,
): void {
  const body = checkWriteResponse(frame, expectedSlaveId, 0x06);
  const addr = (body[2] << 8) | body[3];
  const value = (body[4] << 8) | body[5];
  if (addr !== expectedAddr) {
    throw new ModbusError(`Write echoed wrong address ${addr} (expected ${expectedAddr})`);
  }
  if (value !== expectedValue) {
    throw new ModbusError(`Write echoed wrong value ${value} (expected ${expectedValue})`);
  }
}

/** Parse a function 0x10 response, verifying the echoed address and count. */
export function parseWriteMultipleRegistersResponse(
  frame: Uint8Array,
  expectedSlaveId: number,
  expectedAddr: number,
  expectedQuantity: number,
): void {
  const body = checkWriteResponse(frame, expectedSlaveId, 0x10);
  const addr = (body[2] << 8) | body[3];
  const quantity = (body[4] << 8) | body[5];
  if (addr !== expectedAddr) {
    throw new ModbusError(`Write echoed wrong address ${addr} (expected ${expectedAddr})`);
  }
  if (quantity !== expectedQuantity) {
    throw new ModbusError(
      `Write echoed wrong quantity ${quantity} (expected ${expectedQuantity})`,
    );
  }
}
