import net from "node:net";
import { readFile } from "node:fs/promises";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { Duplex } from "node:stream";
import selfsigned from "selfsigned";
import type { RuntimeManager } from "../runtime/manager.js";
import { LoggerSession } from "./session.js";

/**
 * Duplex view over a net.Socket. TLSSocket over a raw net.Socket reads from
 * the native handle and never sees bytes already pulled into JS land (our
 * peeked ClientHello), so TLS connections are wrapped through this instead —
 * it forces Node's JS-stream TLS path, which respects unshifted data.
 */
class SocketTap extends Duplex {
  constructor(private readonly raw: net.Socket) {
    super();
    raw.on("data", (c: Buffer) => {
      if (!this.push(c)) raw.pause();
    });
    raw.on("end", () => this.push(null));
    raw.on("error", (e) => this.destroy(e));
    raw.on("close", () => this.destroy());
  }
  override _read(): void {
    this.raw.resume();
  }
  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.raw.write(chunk, cb);
  }
  override _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    this.raw.destroy();
    cb(err);
  }
}

/** How long an unclaimed stick may stay connected (enough for the claim wizard). */
const UNCLAIMED_GRACE_MS = 60000;
/** How long an unclaimed sighting is offered to the claim wizard. */
const SIGHTING_TTL_MS = 10 * 60000;
/** TLS handshakes that take longer than this are dead. */
const TLS_HANDSHAKE_TIMEOUT_MS = 15000;

export interface GatewayOptions {
  port: number;
  host?: string;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  /** Paths to a real TLS cert (fullchain) + key; falls back to self-signed. */
  tlsCertFile?: string;
  tlsKeyFile?: string;
}

interface Sighting {
  serial: number;
  ip: string;
  lastSeenAt: number;
}

/**
 * TCP server the Solarman sticks connect to ("Server B" mode). Sessions are
 * identified by the logger serial in their first frame; claimed serials are
 * attached to their environment's runtime, unknown ones are remembered
 * briefly (for the claim wizard) and then dropped.
 */
export class LoggerGateway {
  private readonly server: net.Server;
  private readonly sessions = new Map<number, LoggerSession>();
  private readonly perIp = new Map<string, number>();
  private readonly unclaimed = new Map<number, Sighting>();
  private readonly graceTimers = new Map<LoggerSession, NodeJS.Timeout>();
  private connections = 0;
  private tlsContext: tls.SecureContext | null = null;

  constructor(
    private readonly manager: RuntimeManager,
    private readonly log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
    private readonly opts: GatewayOptions,
  ) {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async listen(): Promise<void> {
    // Newer stick firmwares (e.g. LSW5) wrap the V5 protocol in TLS and
    // validate the server certificate against public CAs ("unknown ca" alert
    // otherwise), so a real cert is used when configured. Self-signed is the
    // fallback for tests and firmwares that skip validation.
    let key: string;
    let cert: string;
    if (this.opts.tlsCertFile && this.opts.tlsKeyFile) {
      [cert, key] = await Promise.all([
        readFile(this.opts.tlsCertFile, "utf8"),
        readFile(this.opts.tlsKeyFile, "utf8"),
      ]);
      this.log.info(`Logger gateway: using TLS certificate from ${this.opts.tlsCertFile}`);
      this.logCertChain(cert);
    } else {
      const pems = await selfsigned.generate([{ name: "commonName", value: "helio-gateway" }], {
        keySize: 2048,
        notAfterDate: new Date(Date.now() + 3650 * 24 * 3600 * 1000),
      });
      key = pems.private;
      cert = pems.cert;
      this.log.info("Logger gateway: using self-signed TLS certificate");
    }
    this.tlsContext = tls.createSecureContext({
      key,
      cert,
      // Sticks use older TLS1.2 CBC suites; accept the widest set possible.
      minVersion: "TLSv1",
      ciphers: "ALL:@SECLEVEL=0",
    });

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => {
        this.server.removeListener("error", reject);
        this.log.info(`Logger gateway listening on :${this.opts.port} (plain V5 + TLS)`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const session of [...this.sessions.values()]) session.close("gateway shutdown");
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  isConnected(serial: number): boolean {
    return this.sessions.has(serial);
  }

  /** Unclaimed sticks recently seen from this public IP (claim wizard hint). */
  unclaimedForIp(ip: string): number[] {
    const now = Date.now();
    return [...this.unclaimed.values()]
      .filter((s) => s.ip === ip && now - s.lastSeenAt < SIGHTING_TTL_MS)
      .map((s) => s.serial);
  }

  /** A serial was just claimed; attach it if its stick is already connected. */
  async tryAttach(serial: number): Promise<boolean> {
    const session = this.sessions.get(serial);
    if (!session) return false;
    const attached = await this.manager.attachLogger(serial, session);
    if (attached) {
      this.clearGrace(session);
      this.unclaimed.delete(serial);
    }
    return attached;
  }

  private onConnection(raw: net.Socket): void {
    const ip = raw.remoteAddress ?? "unknown";
    const max = this.opts.maxConnections ?? 500;
    const maxPerIp = this.opts.maxConnectionsPerIp ?? 5;
    if (this.connections >= max || (this.perIp.get(ip) ?? 0) >= maxPerIp) {
      raw.destroy();
      return;
    }
    this.connections++;
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    // Log every raw connection so "is my stick even reaching the server?"
    // is answerable from the logs, before any frame is parsed.
    this.log.info(`Gateway: connection from ${ip}`);

    // Until a session owns the socket, account for closes here.
    let sessionStarted = false;
    const release = () => {
      if (!sessionStarted) this.releaseConnection(ip);
    };
    raw.on("close", release);
    raw.on("error", () => raw.destroy());
    const peekTimer = setTimeout(() => {
      if (!sessionStarted && !raw.destroyed) {
        this.log.info(`Gateway: connection from ${ip} sent nothing, dropping`);
        raw.destroy();
      }
    }, UNCLAIMED_GRACE_MS);

    // Peek the first byte: 0x16 is a TLS handshake record (newer LSW5
    // firmwares wrap V5 in TLS), anything else is treated as plain V5.
    raw.once("data", (first: Buffer) => {
      clearTimeout(peekTimer);
      if (sessionStarted || raw.destroyed) return;
      raw.pause();
      raw.unshift(first);

      const begin = (socket: net.Socket) => {
        sessionStarted = true;
        raw.removeListener("close", release);
        this.startSession(socket, ip);
      };

      if (first[0] === 0x16 && this.tlsContext) {
        this.log.info(`Gateway: ${ip} speaks TLS, starting handshake`);
        const tlsSocket = new tls.TLSSocket(new SocketTap(raw) as unknown as net.Socket, {
          isServer: true,
          secureContext: this.tlsContext,
        });
        const hsTimer = setTimeout(() => {
          if (!sessionStarted) {
            this.log.warn(`Gateway: TLS handshake with ${ip} timed out`);
            tlsSocket.destroy();
            raw.destroy();
          }
        }, TLS_HANDSHAKE_TIMEOUT_MS);
        tlsSocket.on("error", (err) => {
          this.log.warn(`Gateway: TLS error from ${ip}: ${(err as Error).message}`);
          tlsSocket.destroy();
          raw.destroy();
        });
        tlsSocket.once("secure", () => {
          clearTimeout(hsTimer);
          this.log.info(`Gateway: TLS established with ${ip}`);
          begin(tlsSocket as unknown as net.Socket);
        });
        raw.resume();
      } else {
        begin(raw);
        raw.resume();
      }
    });
  }

  /**
   * Logs every certificate in the PEM so a "unknown ca" alert from the stick
   * can be diagnosed: a chain with only the leaf (no intermediate) is the most
   * common cause, since embedded TLS stacks don't fetch intermediates.
   */
  private logCertChain(pem: string): void {
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    this.log.info(`Logger gateway: TLS chain has ${blocks.length} certificate(s)`);
    if (blocks.length < 2) {
      this.log.warn(
        "Logger gateway: chain has no intermediate — sticks that don't fetch " +
          "intermediates will reject it with 'unknown ca'. Use the full chain.",
      );
    }
    blocks.forEach((block, i) => {
      try {
        const x = new X509Certificate(block);
        this.log.info(
          `Logger gateway: cert[${i}] subject=${x.subject.replace(/\n/g, " ")} ` +
            `issuer=${x.issuer.replace(/\n/g, " ")} validTo=${x.validTo}`,
        );
      } catch (err) {
        this.log.warn(`Logger gateway: cert[${i}] could not be parsed: ${(err as Error).message}`);
      }
    });
  }

  private releaseConnection(ip: string): void {
    this.connections = Math.max(0, this.connections - 1);
    const n = (this.perIp.get(ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, n);
  }

  private startSession(socket: net.Socket, ip: string): void {
    const session = new LoggerSession(
      socket,
      {
        onSerial: (s) => void this.onSerial(s),
        onClose: (s) => void this.onClose(s, ip),
      },
      this.log,
      ip,
    );

    // A stick that never identifies itself gets dropped quickly.
    this.graceTimers.set(
      session,
      setTimeout(() => session.close("no serial"), UNCLAIMED_GRACE_MS),
    );
  }

  private clearGrace(session: LoggerSession): void {
    const timer = this.graceTimers.get(session);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(session);
    }
  }

  private async onSerial(session: LoggerSession): Promise<void> {
    const serial = session.serial!;

    // A reconnect replaces the previous session for the same serial.
    const previous = this.sessions.get(serial);
    if (previous && previous !== session) {
      this.log.info(`Logger ${serial}: new connection replaces the old one`);
      previous.close("replaced by new connection");
    }
    this.sessions.set(serial, session);

    let attached = false;
    try {
      attached = await this.manager.attachLogger(serial, session);
    } catch (err) {
      this.log.warn(`Logger ${serial}: attach failed: ${(err as Error).message}`);
    }
    if (session.isClosed) return;

    if (attached) {
      this.clearGrace(session);
      this.unclaimed.delete(serial);
      this.log.info(`Logger ${serial} attached (${session.remoteIp})`);
    } else {
      // Unknown serial: remember the sighting for the claim wizard, then drop.
      this.unclaimed.set(serial, { serial, ip: session.remoteIp, lastSeenAt: Date.now() });
      this.clearGrace(session);
      this.graceTimers.set(
        session,
        setTimeout(() => {
          if (!session.isClosed) session.close("unclaimed serial");
        }, UNCLAIMED_GRACE_MS),
      );
      this.log.info(`Logger ${serial} connected but unclaimed (${session.remoteIp})`);
    }
  }

  private async onClose(session: LoggerSession, ip: string): Promise<void> {
    this.clearGrace(session);
    this.releaseConnection(ip);

    const serial = session.serial;
    if (serial === null) {
      this.log.info(`Gateway: connection from ${ip} closed before identifying itself`);
    }
    if (serial !== null && this.sessions.get(serial) === session) {
      this.sessions.delete(serial);
      try {
        await this.manager.detachSerial(serial);
      } catch (err) {
        this.log.warn(`Logger ${serial}: detach failed: ${(err as Error).message}`);
      }
      this.log.info(`Logger ${serial} disconnected`);
    }
  }
}
