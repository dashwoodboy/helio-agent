/**
 * A fake Solarman stick in "direct/LAN" mode for agent tests: answers the
 * UDP discovery probe with `IP,MAC,SERIAL` and serves Solarman V5 Modbus on
 * an ephemeral TCP port — the server side of what `SolarmanClient` speaks.
 * The register model is the backend's simulator, same as fake-logger.
 */
import dgram from "node:dgram";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  extractV5Frames,
  parseFrameHeader,
  V5_CONTROL_REQUEST,
} from "../../backend/src/solarman/v5frame.js";
import { checkCrc, withCrc } from "../../backend/src/solarman/crc.js";
import { SimulatedInverter } from "../../backend/src/inverter/simulator.js";
import { defaultSimulatedRegisters } from "../../backend/src/inverter/control.js";
import { buildResponseFrame, registersFrom } from "../../backend/scripts/fake-logger.js";
import { DISCOVERY_PROBE } from "../src/core/discovery.js";

export interface FakeStickHandle {
  serial: number;
  tcpPort: number;
  udpPort: number;
  /** Mutable settings register bank (written by 0x06/0x10). */
  registers: Map<number, number>;
  stop: () => Promise<void>;
}

export async function startFakeStick(opts: {
  serial: number;
  /** Omit the serial from the discovery reply (older firmwares). */
  hideSerial?: boolean;
}): Promise<FakeStickHandle> {
  const simulator = new SimulatedInverter({ kwp: 5.5, batteryCapacityKwh: 16 });
  const simConfig = { phases: 1 as const, hasBattery: true, pvStrings: 2 as const, hasGenerator: false };
  const settingsBank = defaultSimulatedRegisters();

  // ---- TCP: V5/Modbus server, same request handling as fake-logger.
  const open = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("error", () => socket.destroy());
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
          if (header.controlCode !== V5_CONTROL_REQUEST) continue;

          const modbusReq = frame.subarray(26, frame.length - 2);
          const body = checkCrc(modbusReq);
          if (!body) continue;
          const fn = body[1];
          const start = (body[2] << 8) | body[3];

          let response: Uint8Array;
          if (fn === 0x03) {
            const quantity = (body[4] << 8) | body[5];
            const live = registersFrom(await simulator.readFull(simConfig));
            const lookup = (addr: number) => live.get(addr) ?? settingsBank.get(addr);
            const known = [...Array(quantity).keys()].some((i) => lookup(start + i) !== undefined);
            if (!known) {
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
            if (!settingsBank.has(start)) {
              response = withCrc(new Uint8Array([1, 0x86, 0x02]));
            } else {
              settingsBank.set(start, value);
              response = withCrc(body);
            }
          } else if (fn === 0x10) {
            const quantity = (body[4] << 8) | body[5];
            const blocked = [...Array(quantity).keys()].some((i) => !settingsBank.has(start + i));
            if (blocked || body.length < 7 + quantity * 2) {
              response = withCrc(new Uint8Array([1, 0x90, 0x02]));
            } else {
              for (let i = 0; i < quantity; i++) {
                settingsBank.set(start + i, (body[7 + i * 2] << 8) | body[8 + i * 2]);
              }
              response = withCrc(body.subarray(0, 6));
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
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const tcpPort = (tcp.address() as AddressInfo).port;

  // ---- UDP: discovery responder ("WIFIKIT-214028-READ" → "IP,MAC,SERIAL").
  const udp = dgram.createSocket("udp4");
  udp.on("message", (msg, rinfo) => {
    if (msg.toString("ascii") !== DISCOVERY_PROBE) return;
    const reply = opts.hideSerial
      ? "127.0.0.1,AABBCCDDEEFF"
      : `127.0.0.1,AABBCCDDEEFF,${opts.serial}`;
    udp.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const udpPort = (udp.address() as AddressInfo).port;

  return {
    serial: opts.serial,
    tcpPort,
    udpPort,
    registers: settingsBank,
    stop: async () => {
      udp.close();
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    },
  };
}
