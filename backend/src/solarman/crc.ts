/** Modbus RTU CRC-16 (polynomial 0xA001, init 0xFFFF). */
export function crc16Modbus(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xffff;
}

/** Append little-endian CRC16 to a Modbus RTU PDU. */
export function withCrc(frame: Uint8Array): Uint8Array {
  const crc = crc16Modbus(frame);
  const out = new Uint8Array(frame.length + 2);
  out.set(frame);
  out[frame.length] = crc & 0xff;
  out[frame.length + 1] = (crc >> 8) & 0xff;
  return out;
}

/** Validate and strip the trailing CRC16; returns null when invalid. */
export function checkCrc(frame: Uint8Array): Uint8Array | null {
  if (frame.length < 3) return null;
  const body = frame.subarray(0, frame.length - 2);
  const expected = crc16Modbus(body);
  const got = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  return expected === got ? body : null;
}
