// Date ranges for the super admin metrics: whole UTC days, inclusive of the end day, with a previous period of the same length.

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

export interface MetricsRange {
  /** Start of the first day (UTC). */
  from: Date;
  /** Last millisecond of the last day (UTC): the range is inclusive of the end day. */
  to: Date;
  days: number;
  /** "YYYY-MM-DD" for every day of the range, oldest first. */
  dayKeys: string[];
  previous: { from: Date; to: Date; dayKeys: string[] } | null;
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function parseDay(v: string): Date {
  return startOfUtcDay(new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v));
}

function keysBetween(first: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) => dayKey(new Date(first.getTime() + i * DAY_MS)));
}

export class RangeError422 extends Error {
  statusCode = 422;
}

export function resolveRange(input: { from?: string; to?: string; compare?: boolean }, now = new Date()): MetricsRange {
  const toDay = input.to ? parseDay(input.to) : startOfUtcDay(now);
  const fromDay = input.from ? parseDay(input.from) : new Date(toDay.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  if (fromDay.getTime() > toDay.getTime()) throw new RangeError422("`from` must not be after `to`.");
  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw new RangeError422(`The range is limited to ${MAX_RANGE_DAYS} days.`);

  const to = new Date(toDay.getTime() + DAY_MS - 1);
  const compare = input.compare !== false;
  let previous: MetricsRange["previous"] = null;
  if (compare) {
    const prevFrom = new Date(fromDay.getTime() - days * DAY_MS);
    previous = { from: prevFrom, to: new Date(fromDay.getTime() - 1), dayKeys: keysBetween(prevFrom, days) };
  }
  return { from: fromDay, to, days, dayKeys: keysBetween(fromDay, days), previous };
}

/** Turns grouped rows ({ _id: "YYYY-MM-DD", n }) into one number per day, with 0 for days that have no row. */
export function denseSeries(dayKeys: string[], rows: { _id: string; n: number }[]): number[] {
  const byDay = new Map(rows.map((r) => [r._id, r.n]));
  return dayKeys.map((k) => byDay.get(k) ?? 0);
}
