import type net from "node:net";
import {
  decodeV5Frame,
  encodeLoggerAckFrame,
  encodeV5Frame,
  extractV5Frames,
  LOGGER_PUSH_CONTROL_CODES,
  parseFrameHeader,
  V5_CONTROL_RESPONSE,
  validateFrameEnvelope,
} from "../solarman/v5frame.js";
import {
  parseReadHoldingRegistersResponse,
  parseWriteMultipleRegistersResponse,
  parseWriteSingleRegisterResponse,
  readHoldingRegistersRequest,
  writeMultipleRegistersRequest,
  writeSingleRegisterRequest,
} from "../solarman/modbus.js";
import type { WritableRegisterTransport } from "../solarman/transport.js";

/** Hard cap on a single V5 frame; sticks send far smaller frames. */
const MAX_FRAME_BYTES = 2048;
/** Reassembly buffer cap; beyond this the peer is misbehaving. */
const MAX_BUFFER_BYTES = 16384;
const REQUEST_TIMEOUT_MS = 10000;

export class LoggerSessionError extends Error {}

export interface LoggerSessionEvents {
  /** First frame identified the stick. */
  onSerial: (session: LoggerSession) => void;
  onClose: (session: LoggerSession) => void;
}

interface PendingRead {
  seq: number;
  resolve: (frame: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One inbound stick connection. ACKs the logger-initiated frames and
 * implements WritableRegisterTransport by sending 0x4510 requests over
 * the same socket (one request in flight at a time). Reads come from the
 * poller; writes only from the guarded inverter-settings API.
 */
export class LoggerSession implements WritableRegisterTransport {
  serial: number | null = null;
  readonly remoteIp: string;
  readonly connectedAt = new Date();
  private buffer: Buffer = Buffer.alloc(0);
  private pending: PendingRead | null = null;
  /** Serializes reads so only one request is in flight per stick. */
  private chain: Promise<unknown> = Promise.resolve();
  private sequence = Math.floor(Math.random() * 254) + 1;
  private closed = false;
  private warnedCorrupt = false;
  private loggedFirstBytes = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly events: LoggerSessionEvents,
    private readonly log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
    remoteIp?: string,
  ) {
    this.remoteIp = remoteIp ?? socket.remoteAddress ?? "unknown";
    try {
      socket.setNoDelay(true);
    } catch {
      // TLS sockets over a JS-stream wrapper don't support it — fine.
    }
    socket.setTimeout(10 * 60000, () => this.close("idle timeout"));
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => this.close("socket error"));
    socket.on("close", () => this.close("socket closed"));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new LoggerSessionError(`Logger session ${reason}`));
      this.pending = null;
    }
    this.socket.destroy();
    this.events.onClose(this);
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    // Until the stick identifies itself, log what it actually sends — the
    // fastest way to diagnose protocol mismatches in the field.
    if (!this.loggedFirstBytes && this.serial === null) {
      this.loggedFirstBytes = true;
      this.log.info(
        `Gateway: ${this.remoteIp} first bytes (${chunk.length}): ${chunk.subarray(0, 48).toString("hex")}`,
      );
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.log.warn(`Logger ${this.serial ?? this.remoteIp}: buffer overflow, closing`);
      this.close("buffer overflow");
      return;
    }
    const { frames, rest } = extractV5Frames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame.length > MAX_FRAME_BYTES) {
        this.close("oversized frame");
        return;
      }
      this.handleFrame(frame);
      if (this.closed) return;
    }
  }

  private handleFrame(frame: Uint8Array): void {
    if (!validateFrameEnvelope(frame)) {
      // Ignore corrupt frames, but leave one trace per session for diagnosis.
      if (!this.warnedCorrupt) {
        this.warnedCorrupt = true;
        const preview = Buffer.from(frame.slice(0, 16)).toString("hex");
        this.log.warn(`Gateway: ${this.remoteIp} sent unrecognized data (${preview}…)`);
      }
      return;
    }
    let header;
    try {
      header = parseFrameHeader(frame);
    } catch {
      return;
    }

    if (this.serial === null && header.loggerSerial > 0) {
      this.serial = header.loggerSerial;
      this.events.onSerial(this);
      if (this.closed) return;
    }

    if (LOGGER_PUSH_CONTROL_CODES.has(header.controlCode)) {
      // Handshake / data / wifi / heartbeat: ACK with the time response.
      this.socket.write(encodeLoggerAckFrame(frame));
      return;
    }

    if (header.controlCode === V5_CONTROL_RESPONSE && this.pending) {
      if ((header.sequence & 0xff) === (this.pending.seq & 0xff)) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(frame);
      }
    }
  }

  // ------------------------------------------------------- RegisterTransport

  async connect(): Promise<void> {
    if (this.closed) throw new LoggerSessionError("Logger session is closed");
  }

  async disconnect(): Promise<void> {
    // The stick owns the connection lifetime; nothing to do.
  }

  async readHoldingRegisters(startAddr: number, quantity: number): Promise<number[]> {
    const modbusFrame = await this.enqueue(
      () => readHoldingRegistersRequest(1, startAddr, quantity),
      `registers ${startAddr}+${quantity}`,
    );
    return parseReadHoldingRegistersResponse(modbusFrame, 1);
  }

  async writeHoldingRegister(addr: number, value: number): Promise<void> {
    const modbusFrame = await this.enqueue(
      () => writeSingleRegisterRequest(1, addr, value),
      `write ${addr}`,
    );
    parseWriteSingleRegisterResponse(modbusFrame, 1, addr, value);
  }

  async writeHoldingRegisters(startAddr: number, values: number[]): Promise<void> {
    const modbusFrame = await this.enqueue(
      () => writeMultipleRegistersRequest(1, startAddr, values),
      `write ${startAddr}+${values.length}`,
    );
    parseWriteMultipleRegistersResponse(modbusFrame, 1, startAddr, values.length);
  }

  /** Serialize a request through the one-in-flight chain. */
  private enqueue(buildModbus: () => Uint8Array, what: string): Promise<Uint8Array> {
    const run = this.chain.then(() => this.doRequest(buildModbus(), what));
    // Keep the chain alive even when a request fails.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doRequest(mbRequest: Uint8Array, what: string): Promise<Uint8Array> {
    if (this.closed || this.serial === null) {
      throw new LoggerSessionError("Logger session is not available");
    }
    const serial = this.serial;
    this.sequence = (this.sequence + 1) & 0xff || 1;
    const seq = this.sequence;
    const request = encodeV5Frame(mbRequest, serial, seq);

    const responseFrame = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.seq === seq) this.pending = null;
        reject(new LoggerSessionError(`Timeout awaiting response for ${what}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending = { seq, resolve, reject, timer };
      this.socket.write(request, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending = null;
          reject(err);
        }
      });
    });

    const decoded = decodeV5Frame(responseFrame, { sequenceNumber: seq, loggerSerial: serial });
    return decoded.modbusFrame;
  }
}
