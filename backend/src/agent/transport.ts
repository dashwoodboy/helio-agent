import type { WritableRegisterTransport } from "../solarman/transport.js";
import { AgentRpcError, type AgentSession } from "./hub.js";

/**
 * WritableRegisterTransport over a connected Helio Agent: every read/write
 * becomes an RPC the agent executes against the stick on its LAN. The server
 * never supplies an address — only the stick serial; the agent resolves it
 * from its own discovery, so a compromised server cannot aim the agent at
 * arbitrary hosts.
 */
export class AgentStickTransport implements WritableRegisterTransport {
  constructor(
    private readonly session: AgentSession,
    private readonly serial: number,
  ) {}

  async connect(): Promise<void> {
    if (this.session.closed) throw new AgentRpcError("Agent is not connected");
  }

  async disconnect(): Promise<void> {
    // The agent owns the stick sockets; nothing to do here.
  }

  async readHoldingRegisters(startAddr: number, quantity: number): Promise<number[]> {
    const values = await this.session.rpc({
      serial: this.serial,
      op: "read",
      addr: startAddr,
      quantity,
    });
    if (!values || values.length !== quantity) {
      throw new AgentRpcError(`Agent returned ${values?.length ?? 0}/${quantity} registers`);
    }
    return values;
  }

  async writeHoldingRegister(addr: number, value: number): Promise<void> {
    await this.session.rpc({ serial: this.serial, op: "write1", addr, value });
  }

  async writeHoldingRegisters(startAddr: number, values: number[]): Promise<void> {
    await this.session.rpc({ serial: this.serial, op: "writeN", addr: startAddr, values });
  }
}
