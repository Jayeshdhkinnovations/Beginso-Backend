import type { Server } from "http";

export interface ShutdownOptions {
  /** How long in-flight requests get to finish before the process leaves anyway. */
  timeoutMs?: number;
  /** Closes the database connection. Awaited, and its failure never blocks the exit. */
  closeDb?: () => Promise<unknown>;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

/** 25 s: under Docker's default 30 s stop grace, and long enough for an upload or a report in flight. */
export const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Stops taking new connections, waits for the requests already running, closes the database and exits 0.
 * If they do not finish in `timeoutMs` the process leaves anyway (exit 0 as before: the platform's own stop timer is the backstop).
 * Safe to call twice: the second call does nothing.
 */
export const createShutdown = (server: Pick<Server, "close" | "closeIdleConnections">, options: ShutdownOptions = {}) => {
  const { timeoutMs = SHUTDOWN_TIMEOUT_MS, closeDb, exit = (code: number) => process.exit(code), log = console.log } = options;
  let started = false;

  return async (signal: string): Promise<void> => {
    if (started) return;
    started = true;
    log(`${signal} received, shutting down`);

    const timer = setTimeout(() => {
      log(`shutdown: requests still running after ${timeoutMs} ms, leaving anyway`);
      exit(0);
    }, timeoutMs);
    timer.unref();

    // Idle keep-alive sockets would hold close() open for their whole timeout; the ones doing work are left to finish.
    server.closeIdleConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (closeDb) await closeDb().catch((e) => log(`shutdown: closing the database failed: ${e instanceof Error ? e.message : String(e)}`));
    clearTimeout(timer);
    exit(0);
  };
};
