import { existsSync } from "node:fs";
import { join } from "node:path";

/** ccusage resolves zone names from the zoneinfo files on disk, which slim images leave out. */
export function assertZoneinfo(tz: string): void {
  const file = join(process.env.TZDIR || "/usr/share/zoneinfo", tz);
  if (!existsSync(file)) {
    throw new Error(`${file} is missing, so ccusage would silently use the system time zone. Install tzdata.`);
  }
}

export function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bun has no default signal handling as PID 1 in a container, so `docker stop` would hang. */
export function exitOnSignals(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
}
