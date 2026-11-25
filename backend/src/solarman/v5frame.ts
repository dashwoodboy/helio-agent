/**
 * Solarman V5 framing, ported byte-for-byte from pysolarmanv5.
 *
 * Request frame layout:
 *   [0]      start        0xA5
 *   [1..2]   length (LE)  = 15 + len(modbus frame)
 *   [3..4]   control code (LE) 0x4510
 *   [5..6]   sequence number (LE u16, low byte cycles 1..255)
 *   [7..10]  logger serial (LE u32)
 *   [11]     frame type   0x02
 *   [12..13] sensor type  0x0000
 *   [14..17] delivery time 0
 *   [18..21] power-on time 0
 *   [22..25] offset time   0
 *   [26..]   Modbus RTU frame
 *   [-2]     checksum = sum of bytes [1 .. len-3] & 0xFF
 *   [-1]     end          0x15
 *
 * Responses carry control code 0x1510 and the Modbus RTU frame at
 * bytes [25 .. len-2].
 */

export class V5FrameError extends Error {}

export const V5_START = 0xa5;
export const V5_END = 0x15;
export const V5_CONTROL_REQUEST = 0x4510;
export const V5_CONTROL_RESPONSE = 0x1510;
/** Spurious keep-alive/counter frames the logger may interleave. */
export const V5_CONTROL_COUNTER = 0x4710;

// Logger-initiated control codes seen when the stick connects *to us*
// ("Server B" / optional-server mode).
export const V5_CONTROL_HANDSHAKE = 0x4110;
export const V5_CONTROL_DATA = 0x4210;
export const V5_CONTROL_WIFI = 0x4310;
export const V5_CONTROL_HEARTBEAT = 0x4710;

/** Control codes a logger may send that expect a time-sync ACK from the server. */
export const LOGGER_PUSH_CONTROL_CODES = new Set([
  V5_CONTROL_HANDSHAKE,
  V5_CONTROL_DATA,
  V5_CONTROL_WIFI,
  V5_CONTROL_HEARTBEAT,
]);

export function v5Checksum(frame: Uint8Array): number {
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) {
    sum += frame[i] & 0xff;
  }
  return sum & 0xff;
}

export function encodeV5Frame(
  modbusFrame: Uint8Array,
  loggerSerial: number,
  sequenceNumber: number,
): Uint8Array {
  const frame = new Uint8Array(26 + modbusFrame.length + 2);
  const view = new DataView(frame.buffer);
  frame[0] = V5_START;
  view.setUint16(1, 15 + modbusFrame.length, true);
  view.setUint16(3, V5_CONTROL_REQUEST, true);
  view.setUint16(5, sequenceNumber & 0xff, true);
  view.setUint32(7, loggerSerial >>> 0, true);
  frame[11] = 0x02; // frame type
  // [12..25] sensor type + delivery/power-on/offset time: all zero
  frame.set(modbusFrame, 26);
  frame[frame.length - 2] = v5Checksum(frame);
  frame[frame.length - 1] = V5_END;
  return frame;
}

export interface DecodedV5Frame {
  controlCode: number;
  sequenceNumber: number;
  loggerSerial: number;
  modbusFrame: Uint8Array;
}

/**
 * Decode and validate a V5 response frame. Mirrors pysolarmanv5's
 * _v5_frame_decoder checks. Throws V5FrameError on invalid frames.
 */
export function decodeV5Frame(
  v5Frame: Uint8Array,
  expected: { sequenceNumber: number; loggerSerial: number },
): DecodedV5Frame {
  const frameLen = v5Frame.length;
  if (frameLen < 13) throw new V5FrameError("V5 frame too short");
  const view = new DataView(v5Frame.buffer, v5Frame.byteOffset, v5Frame.byteLength);
  const payloadLen = view.getUint16(1, true);
  if (frameLen !== 13 + payloadLen) {
    throw new V5FrameError("V5 frame length does not match payload length");
  }
  if (v5Frame[0] !== V5_START || v5Frame[frameLen - 1] !== V5_END) {
    throw new V5FrameError("V5 frame contains invalid start or end values");
  }
  if (v5Frame[frameLen - 2] !== v5Checksum(v5Frame)) {
    throw new V5FrameError("V5 frame contains invalid V5 checksum");
  }
  const controlCode = view.getUint16(3, true);
  if (controlCode !== V5_CONTROL_RESPONSE) {
    throw new V5FrameError(
      `V5 frame contains incorrect control code 0x${controlCode.toString(16)}`,
    );
  }
  if (v5Frame[5] !== (expected.sequenceNumber & 0xff)) {
    throw new V5FrameError("V5 frame contains invalid sequence number");
  }
  const loggerSerial = view.getUint32(7, true);
  if (loggerSerial !== (expected.loggerSerial >>> 0)) {
    throw new V5FrameError("V5 frame contains incorrect data logger serial number");
  }
  if (v5Frame[11] !== 0x02) {
    throw new V5FrameError("V5 frame contains invalid frametype");
  }
  const modbusFrame = v5Frame.subarray(25, frameLen - 2);
  if (modbusFrame.length < 5) {
    throw new V5FrameError("V5 frame does not contain a valid Modbus RTU frame");
  }
  return {
    controlCode,
    sequenceNumber: v5Frame[5],
    loggerSerial,
    modbusFrame,
  };
}

/** Peek a frame's control code without full validation (for skipping keep-alives). */
export function peekControlCode(v5Frame: Uint8Array): number | null {
  if (v5Frame.length < 5) return null;
  return v5Frame[3] | (v5Frame[4] << 8);
}

export interface V5FrameHeader {
  payloadLen: number;
  controlCode: number;
  /** Full 16-bit sequence field (little-endian bytes 5..6). */
  sequence: number;
  loggerSerial: number;
  frameType: number | null;
}

/** Parse the common V5 header of any frame (request or logger push). */
export function parseFrameHeader(v5Frame: Uint8Array): V5FrameHeader {
  if (v5Frame.length < 13) throw new V5FrameError("V5 frame too short");
  const view = new DataView(v5Frame.buffer, v5Frame.byteOffset, v5Frame.byteLength);
  return {
    payloadLen: view.getUint16(1, true),
    controlCode: view.getUint16(3, true),
    sequence: view.getUint16(5, true),
    loggerSerial: view.getUint32(7, true),
    frameType: v5Frame.length > 11 ? v5Frame[11] : null,
  };
}

/** Validate framing only (start/end/length/checksum), regardless of direction. */
export function validateFrameEnvelope(v5Frame: Uint8Array): boolean {
  const len = v5Frame.length;
  if (len < 13) return false;
  const view = new DataView(v5Frame.buffer, v5Frame.byteOffset, v5Frame.byteLength);
  if (len !== 13 + view.getUint16(1, true)) return false;
  if (v5Frame[0] !== V5_START || v5Frame[len - 1] !== V5_END) return false;
  return v5Frame[len - 2] === v5Checksum(v5Frame);
}

/**
 * Build the server ACK for a logger-initiated frame (handshake 0x4110,
 * data 0x4210, wifi 0x4310, heartbeat 0x4710). Mirrors pysolarmanv5's
 * time-response frame: control code high byte minus 0x30, first sequence
 * byte incremented, payload = frame type + status + unix time + offset.
 */
export function encodeLoggerAckFrame(
  loggerFrame: Uint8Array,
  nowS: number = Math.floor(Date.now() / 1000),
): Uint8Array {
  const header = parseFrameHeader(loggerFrame);
  const payload = new Uint8Array(10);
  const pview = new DataView(payload.buffer);
  payload[0] = header.frameType ?? 0x01;
  payload[1] = 0x01; // status: accepted
  pview.setUint32(2, nowS >>> 0, true);
  pview.setUint32(6, 0, true); // offset

  const frame = new Uint8Array(11 + payload.length + 2);
  const view = new DataView(frame.buffer);
  frame[0] = V5_START;
  view.setUint16(1, payload.length, true);
  view.setUint16(3, (header.controlCode - 0x3000) & 0xffff, true);
  // Echo the sequence with the low byte incremented (observed logger behaviour).
  frame[5] = (loggerFrame[5] + 1) & 0xff;
  frame[6] = loggerFrame[6];
  view.setUint32(7, header.loggerSerial >>> 0, true);
  frame.set(payload, 11);
  frame[frame.length - 2] = v5Checksum(frame);
  frame[frame.length - 1] = V5_END;
  return frame;
}

/**
 * Extract complete V5 frames from a TCP stream buffer. Returns the frames
 * found and the remaining (incomplete) tail. Garbage before a start byte
 * is discarded.
 */
export function extractV5Frames(buffer: Buffer): { frames: Uint8Array[]; rest: Buffer } {
  const frames: Uint8Array[] = [];
  let buf = buffer;
  for (;;) {
    const start = buf.indexOf(V5_START);
    if (start < 0) return { frames, rest: Buffer.alloc(0) };
    if (start > 0) buf = buf.subarray(start);
    if (buf.length < 13) return { frames, rest: buf };
    const payloadLen = buf.readUInt16LE(1);
    const frameLen = 13 + payloadLen;
    if (buf.length < frameLen) return { frames, rest: buf };
    frames.push(new Uint8Array(buf.subarray(0, frameLen)));
    buf = buf.subarray(frameLen);
  }
}
