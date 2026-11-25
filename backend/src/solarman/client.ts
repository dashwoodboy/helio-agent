import net from "node:net";
import {
  decodeV5Frame,
  encodeV5Frame,
  peekControlCode,
  V5_CONTROL_RESPONSE,
  V5FrameError,
  V5_START,
} from "./v5frame.js";
import {
  parseReadHoldingRegistersResponse,
  parseWriteMultipleRegistersResponse,
  parseWriteSingleRegisterResponse,
  readHoldingRegistersRequest,
  writeMultipleRegistersRequest,
  writeSingleRegisterRequest,
} from "./modbus.js";
import type { WritableRegisterTransport } from "./transport.js";

export class SolarmanTimeoutError extends Error {}

export interface SolarmanClientOptions {
  address: string;
  serial: number;
  port?: number;
  slaveId?: number;
  socketTimeoutMs?: number;
}

/**
 * Minimal Solarman V5 TCP client: connects, sends read-holding-registers
 * requests, matches responses by sequence number, skips keep-alive frames.
 * Open per poll cycle and close after, like the logger prefers.
 */
export class SolarmanClient implements WritableRegisterTransport {
  private readonly address: string;
  private readonly serial: number;
  private readonly port: number;
  private readonly slaveId: number;
  private readonly timeoutMs: number;
  private socket: net.Socket | null = null;
  private sequenceNumber = Math.floor(Math.random() * 254) + 1;

  constructor(opts: SolarmanClientOptions) {
    this.address = opts.address;
    this.serial = opts.serial;
    this.port = opts.port ?? 8899;
    this.slaveId = opts.slaveId ?? 1;
    this.timeoutMs = opts.socketTimeoutMs ?? 10000;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    await this.disconnect();
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.address, port: this.port });
      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new SolarmanTimeoutError(`Connect timeout to ${this.address}:${this.port}`));
      }, this.timeoutMs);
      sock.once("error", onError);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.removeListener("error", onError);
        sock.setNoDelay(true);
        this.socket = sock;
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private nextSequenceNumber(): number {
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xff;
    if (this.sequenceNumber === 0) this.sequenceNumber = 1;
    return this.sequenceNumber;
  }

  /**
   * Read `quantity` holding registers starting at `startAddr`.
   * Returns unsigned 16-bit register values.
   */
  async readHoldingRegisters(startAddr: number, quantity: number): Promise<number[]> {
    const modbusFrame = await this.exchange(
      readHoldingRegistersRequest(this.slaveId, startAddr, quantity),
      `registers ${startAddr}+${quantity}`,
    );
    return parseReadHoldingRegistersResponse(modbusFrame, this.slaveId);
  }

  /** Write one holding register (Modbus function 0x06). */
  async writeHoldingRegister(addr: number, value: number): Promise<void> {
    const modbusFrame = await this.exchange(
      writeSingleRegisterRequest(this.slaveId, addr, value),
      `write ${addr}`,
    );
    parseWriteSingleRegisterResponse(modbusFrame, this.slaveId, addr, value);
  }

  /** Write consecutive holding registers (Modbus function 0x10). */
  async writeHoldingRegisters(startAddr: number, values: number[]): Promise<void> {
    const modbusFrame = await this.exchange(
      writeMultipleRegistersRequest(this.slaveId, startAddr, values),
      `write ${startAddr}+${values.length}`,
    );
    parseWriteMultipleRegistersResponse(modbusFrame, this.slaveId, startAddr, values.length);
  }

  /** Send one Modbus RTU frame in a V5 envelope and await the matching response. */
  private async exchange(mbRequest: Uint8Array, what: string): Promise<Uint8Array> {
    if (!this.socket) await this.connect();
    const sock = this.socket!;
    const seq = this.nextSequenceNumber();
    const v5Request = encodeV5Frame(mbRequest, this.serial, seq);

    const response = await new Promise<Uint8Array>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const cleanup = () => {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        sock.removeListener("error", onError);
        sock.removeListener("close", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new SolarmanTimeoutError(`Timeout awaiting response for ${what}`));
      }, this.timeoutMs);
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Socket closed while awaiting response"));
      };
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        // Extract complete V5 frames from the stream.
        while (buffer.length >= 13) {
          const start = buffer.indexOf(V5_START);
          if (start < 0) {
            buffer = Buffer.alloc(0);
            return;
          }
          if (start > 0) buffer = buffer.subarray(start);
          if (buffer.length < 13) return;
          const payloadLen = buffer.readUInt16LE(1);
          const frameLen = 13 + payloadLen;
          if (buffer.length < frameLen) return; // wait for more data
          const frame = new Uint8Array(buffer.subarray(0, frameLen));
          buffer = buffer.subarray(frameLen);
          const control = peekControlCode(frame);
          if (control === V5_CONTROL_RESPONSE) {
            cleanup();
            resolve(frame);
            return;
          }
          // Skip keep-alive/counter frames (0x4710) and anything else.
        }
      };
      sock.on("data", onData);
      sock.once("error", onError);
      sock.once("close", onClose);
      sock.write(v5Request);
    });

    let decoded;
    try {
      decoded = decodeV5Frame(response, {
        sequenceNumber: seq,
        loggerSerial: this.serial,
      });
    } catch (err) {
      if (err instanceof V5FrameError) throw err;
      throw new V5FrameError(String(err));
    }
    return decoded.modbusFrame;
  }
}
