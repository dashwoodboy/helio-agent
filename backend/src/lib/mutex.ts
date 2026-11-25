/**
 * Simple FIFO async mutex. Serializes inverter access per environment so
 * a settings write never interleaves with a poll cycle (in direct mode a
 * poll opens and closes the TCP socket; an unguarded write would clobber it).
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
}
