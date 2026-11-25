/**
 * Lightweight agent logging: a ring buffer for the diagnostic report plus an
 * optional rotating file (userData on the desktop app, --log-file on the
 * CLI). Logging must never crash or slow the agent: all file errors are
 * swallowed and writes are synchronous-but-tiny (a line per event, not per
 * sample).
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_CAPACITY = 500;
/** Rotate after ~512 KB; one previous file is kept (<file>.1). */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export class AgentLogger {
  private readonly capacity: number;
  private readonly file: string | null;
  private readonly maxFileBytes: number;
  private readonly buffer: string[] = [];
  private fileBytes = 0;
  private fileBroken = false;

  constructor(opts: { capacity?: number; file?: string | null; maxFileBytes?: number } = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.file = opts.file ?? null;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.fileBytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      } catch {
        this.fileBroken = true;
      }
    }
  }

  log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    this.appendToFile(line);
  }

  /** The most recent lines (newest last). */
  lines(last = this.capacity): string[] {
    return this.buffer.slice(-last);
  }

  private appendToFile(line: string): void {
    if (!this.file || this.fileBroken) return;
    try {
      const data = line + "\n";
      fs.appendFileSync(this.file, data);
      this.fileBytes += Buffer.byteLength(data);
      if (this.fileBytes > this.maxFileBytes) {
        fs.renameSync(this.file, `${this.file}.1`); // replaces the old .1
        this.fileBytes = 0;
      }
    } catch {
      this.fileBroken = true; // stop trying; the ring buffer still works
    }
  }
}
