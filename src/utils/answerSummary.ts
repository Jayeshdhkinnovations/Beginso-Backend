// Per-question summaries for the insights breakdown (QA A7-008): choice questions already had counts per option, but rating, number and
// yes/no questions only returned a few sample answers, so there was no "average rating" or "yes / no split". These are pure functions
// over the raw answer values of one question; the controller picks one by field type.

export interface NumericSummary {
  count: number;
  average: number;
  min: number;
  max: number;
  sum: number;
}

export interface RatingSummary {
  count: number;
  average: number;
  /** The top of the scale: the field's own maximum, or the highest value ever given if that is larger. */
  max: number;
  distribution: { value: number; count: number; percentage: number }[];
}

export interface YesNoSummary {
  yes: number;
  no: number;
  /** Share of the yes + no answers that said yes; 0 when nobody answered. */
  percentageYes: number;
}

const round2 = (n: number) => Number(n.toFixed(2));

/** Numbers only: strings that parse ("4", "4.5") count, anything else (blank, "n/a", NaN, Infinity) is left out. */
export function toNumbers(values: unknown[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "boolean" || v === null || v === undefined) continue;
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function numericSummary(values: unknown[]): NumericSummary | null {
  const nums = toNumbers(values);
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return { count: nums.length, average: round2(sum / nums.length), min: Math.min(...nums), max: Math.max(...nums), sum: round2(sum) };
}

export function ratingSummary(values: unknown[], scaleMax = 5): RatingSummary | null {
  const nums = toNumbers(values).map((n) => Math.round(n)).filter((n) => n >= 1);
  if (nums.length === 0) return null;
  const top = Math.max(Math.max(1, Math.floor(scaleMax) || 5), ...nums);
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    count: nums.length,
    average: round2(sum / nums.length),
    max: top,
    distribution: Array.from({ length: top }, (_, i) => {
      const value = i + 1;
      const count = counts.get(value) ?? 0;
      return { value, count, percentage: round2((count / nums.length) * 100) };
    }),
  };
}

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);

export function yesNoSummary(values: unknown[]): YesNoSummary | null {
  let yes = 0;
  let no = 0;
  for (const v of values) {
    const s = String(v).trim().toLowerCase();
    if (YES.has(s)) yes++;
    else if (NO.has(s)) no++;
  }
  if (yes + no === 0) return null;
  return { yes, no, percentageYes: round2((yes / (yes + no)) * 100) };
}
