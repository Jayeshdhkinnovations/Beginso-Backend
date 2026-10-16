// Pure helpers for the CSV / PDF report exports (kept out of report.service.ts so they can be unit-tested without Mongo).

export const MAX_QUESTION_COLUMNS = 200;
const MAX_DISTINCT_VALUES = 1000;
export const OTHER_COLUMN = "Other answers";

/** Escapes one CSV cell. Guards spreadsheet formula injection, but leaves plain numbers ("-5", "+91...") alone. */
export const csvCell = (val: unknown): string => {
  if (val === null || val === undefined) return '""';
  let str = String(val);
  if (/^[=+\-@\t\r]/.test(str) && !/^[+-]?\d+(\.\d+)?$/.test(str)) str = "'" + str;
  return `"${str.replace(/"/g, '""')}"`;
};

const basename = (s: string): string => {
  const last = s.split(/[\\/]/).pop() || s;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** Turns any stored answer into the plain text a person expects to see in a spreadsheet cell. */
export const formatAnswer = (val: unknown, fieldType?: string): string => {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") {
    if (val.startsWith("data:image/")) return "[drawn signature]";
    if ((fieldType === "file_upload" || fieldType === "image_upload") && /[\\/]/.test(val)) return basename(val);
    return val;
  }
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return val.map((v) => formatAnswer(v, fieldType)).filter((s) => s !== "").join("; ");
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const named = o.name ?? o.filename ?? o.fileName ?? o.originalName;
    if (typeof named === "string") return named;
    if (typeof o.url === "string") return basename(o.url);
    return Object.values(o)
      .map((v) => formatAnswer(v))
      .filter((s) => s !== "")
      .join(", ");
  }
  return String(val);
};

export const statusLabel = (status?: string | null, stageName?: string | null): string => {
  if (stageName) return stageName;
  if (status === "in_progress") return "In progress";
  if (status === "completed") return "Completed";
  return "New";
};

export interface ExportField {
  fieldId?: string;
  _id?: any;
  label: string;
  type: string;
}

export interface FormColumns {
  /** column name for each field, same order as the form's fields */
  names: string[];
}

/**
 * One column per question. Duplicate labels inside a form become "Label (2)"; forms that share a label share
 * the column. Beyond MAX_QUESTION_COLUMNS the remaining questions fall into "Other answers".
 */
export const buildQuestionColumns = (forms: { id: string; fields: ExportField[] }[]) => {
  const columns: string[] = [];
  const known = new Set<string>();
  const byForm = new Map<string, (string | null)[]>();
  for (const form of forms) {
    const seen = new Map<string, number>();
    const names = form.fields.map((f) => {
      const base = (f.label || "Untitled question").trim() || "Untitled question";
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const name = n === 1 ? base : `${base} (${n})`;
      if (!known.has(name)) {
        if (columns.length >= MAX_QUESTION_COLUMNS) return null;
        known.add(name);
        columns.push(name);
      }
      return name;
    });
    byForm.set(form.id, names);
  }
  return { columns, byForm };
};

/** Reads one answer the way the stored data is keyed: by label, field id, or the field's _id. */
export const readAnswer = (answers: Record<string, unknown>, f: ExportField): { key?: string; value: unknown } => {
  for (const key of [f.label, f.fieldId, f._id ? String(f._id) : undefined]) {
    if (key && Object.prototype.hasOwnProperty.call(answers, key)) return { key, value: answers[key] };
  }
  return { value: undefined };
};

/** Fills one row's question cells (aligned to `columns`) and returns text for any answer no question claimed. */
export const rowCells = (
  answers: Record<string, unknown>,
  fields: ExportField[],
  names: (string | null)[],
  columns: string[]
): { cells: string[]; other: string } => {
  const byName = new Map<string, string>();
  const claimed = new Set<string>();
  const overflow: string[] = [];
  fields.forEach((f, i) => {
    const { key, value } = readAnswer(answers, f);
    for (const k of [f.label, f.fieldId, f._id ? String(f._id) : undefined]) if (k) claimed.add(k);
    if (key === undefined) return;
    const text = formatAnswer(value, f.type);
    if (names[i]) byName.set(names[i]!, text);
    else if (text) overflow.push(`${f.label}: ${text}`);
  });
  const extra = Object.entries(answers)
    .filter(([k]) => !claimed.has(k) && k !== "_id")
    .map(([k, v]) => `${k}: ${formatAnswer(v)}`);
  return { cells: columns.map((c) => byName.get(c) ?? ""), other: [...overflow, ...extra].join("; ") };
};

/** Readable download name: beginso-<form-title>-<yyyy-mm-dd>.<ext>. */
export const exportFilename = (title: string | undefined, date: Date, ext: string): string => {
  const slug =
    (title || "all-forms")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .toLowerCase()
      .slice(0, 50)
      .replace(/^-+|-+$/g, "") || "report";
  return `beginso-${slug}-${date.toISOString().slice(0, 10)}.${ext}`;
};

/** Y-axis with whole-number, evenly spaced ticks (0,2,4,6 rather than 0,2,3,5,6). */
export const niceAxis = (maxCount: number): { max: number; step: number; ticks: number[] } => {
  const m = Math.max(1, Math.ceil(maxCount));
  let step = 1;
  for (let mag = 1; ; mag *= 10) {
    const found = [1, 2, 5].map((x) => x * mag).find((s) => Math.ceil(m / s) <= 4);
    if (found) {
      step = found;
      break;
    }
  }
  const max = step * Math.ceil(m / step);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  return { max, step, ticks };
};

const CHOICE_TYPES = new Set(["dropdown", "multiple_choice", "checkbox", "yes_no", "rating"]);

export interface QuestionSummary {
  label: string;
  type: string;
  answered: number;
  /** present for choice-like questions; sorted by count desc */
  counts?: { value: string; count: number }[];
}

/** Accumulates per-question tallies one response at a time, so the PDF can cover the full set without loading it. */
export const createQuestionTally = (fields: ExportField[]) => {
  const tallies = fields.map(() => ({ answered: 0, counts: new Map<string, number>() }));
  return {
    add(answers: Record<string, unknown>) {
      fields.forEach((f, i) => {
        const { key, value } = readAnswer(answers ?? {}, f);
        if (key === undefined) return;
        const text = formatAnswer(value, f.type);
        if (text === "") return;
        tallies[i].answered++;
        if (!CHOICE_TYPES.has(f.type)) return;
        const parts = Array.isArray(value) ? value.map((v) => formatAnswer(v)).filter(Boolean) : [text];
        for (const p of parts) {
          const c = tallies[i].counts;
          // bound memory: a choice question holds a handful of options, but legacy free-text values could be unbounded
          if (c.has(p) || c.size < MAX_DISTINCT_VALUES) c.set(p, (c.get(p) ?? 0) + 1);
        }
      });
    },
    summary(): QuestionSummary[] {
      return fields.map((f, i) => ({
        label: f.label,
        type: f.type,
        answered: tallies[i].answered,
        counts: CHOICE_TYPES.has(f.type)
          ? [...tallies[i].counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
          : undefined,
      }));
    },
  };
};
