// Small guards for user-supplied query values that end up in regexes or database expressions.

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Query strings can arrive as an array (?x=a&x=b) or an object; only accept a plain string.
export const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// $dateToString throws (500) on an unknown timezone, so an unknown one falls back to UTC.
export const safeTimezone = (value: unknown): string => {
  const tz = asString(value);
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};
