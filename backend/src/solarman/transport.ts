/**
 * Transport abstraction for talking to inverter holding registers.
 *
 * Two implementations exist:
 *  - SolarmanClient (direct mode): we open a TCP connection to the stick.
 *  - LoggerSession (gateway mode): the stick opened a TCP connection to
 *    us and we send requests over that connection.
 *
 * The poller and reader only ever receive the read-only RegisterTransport
 * view, so no polling code path can write to an inverter. Writes are the
 * exclusive domain of InverterControl, which requires the writable
 * interface and is only reachable through the guarded settings API.
 */
export interface RegisterTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readHoldingRegisters(startAddr: number, quantity: number): Promise<number[]>;
}

/** Transport that can also write holding registers (functions 0x06/0x10). */
export interface WritableRegisterTransport extends RegisterTransport {
  writeHoldingRegister(addr: number, value: number): Promise<void>;
  writeHoldingRegisters(startAddr: number, values: number[]): Promise<void>;
}
