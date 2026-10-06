import ResponseModel from "../models/Response";
import { submittedAtRange } from "./dateRange";

// Field-level segments (Sprint 14 follow-up, charts v2). ONE definition of "which value(s) did this response
// give for this question", used by BOTH the aggregate (chart) and the list filter (panel), so a chart's bar and
// the panel opened from it can never disagree. Everything runs inside MongoDB ($expr over the free-form
// `answers` map): nothing is pulled into Node memory, and the value is only ever a literal.
//
// Answer lookup: first non-null of answers[fieldId], answers[label], answers[trimmed label], answers[_id]
// (public submit stores label keys; old data is fieldId keyed). Values are trimmed and, for choice fields,
// lower-cased (ASCII only - $toLower's limit) so " pro " == "Pro". Arrays (checkbox) contribute each element.
// Needs MongoDB >= 5.0 ($getField).

export const SEGMENT_OTHER = "__other__"; // answered, but with a value that is not one of the field's options
export const SEGMENT_BLANK = "__blank__"; // no usable answer
export const GRANULARITIES = ["day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export type FieldKind = "choice" | "number" | "date";
export const MAX_BUCKETS = 500; // number / date buckets returned (ascending); `truncated` says more existed

const KINDS: Record<string, FieldKind> = { dropdown: "choice", multiple_choice: "choice", checkbox: "choice", number: "number", date: "date" };
export const fieldKind = (field: any): FieldKind | null => KINDS[field?.type] ?? null;

// Chart types per field kind (server-side validation; `stat` = a single headline figure, the average).
export const CHART_TYPES_BY_KIND: Record<FieldKind, readonly string[]> = {
  choice: ["pie", "donut", "bar", "hbar"],
  number: ["bar", "line", "stat"],
  date: ["line", "area", "bar"],
};

export class SegmentError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

const FORMATS: Record<Granularity, string> = { day: "%Y-%m-%d", week: "%G-W%V", month: "%Y-%m" };
const KEY_RE: Record<Granularity, RegExp> = { day: /^\d{4}-\d{2}-\d{2}$/, week: /^\d{4}-W\d{2}$/, month: /^\d{4}-\d{2}$/ };

export const parseGranularity = (raw: unknown): Granularity => {
  if (raw === undefined || raw === null || raw === "") return "day";
  if (typeof raw === "string" && (GRANULARITIES as readonly string[]).includes(raw)) return raw as Granularity;
  throw new SegmentError(400, "INVALID_GRANULARITY", "granularity must be day, week or month");
};

// Same trim + ASCII lower-casing MongoDB applies, so a JS-side option key equals the $expr-side value.
export const normKey = (s: unknown): string => String(s ?? "").trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
const optionLabel = (opt: any): string => String(typeof opt === "string" ? opt : opt?.label ?? opt?.value ?? "").trim();
export const optionLabels = (field: any): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of field.options || []) {
    const label = optionLabel(o);
    const key = normKey(label);
    if (label && !seen.has(key)) {
      seen.add(key);
      out.push(label);
    }
  }
  return out;
};

const rawExpr = (field: any): any => {
  const keys = [...new Set([field.fieldId, field.label, field.label && String(field.label).trim(), field._id && String(field._id)].filter(Boolean))] as string[];
  return { $ifNull: [...keys.map((k) => ({ $getField: { field: { $literal: k }, input: "$answers" } })), null] };
};
const asArray = { $cond: [{ $isArray: "$$v" }, "$$v", ["$$v"]] };

// Array of the normalised, de-duplicated, non-empty values this response gave for the field.
export const valuesExpr = (field: any, granularity: Granularity = "day"): any => {
  const kind = fieldKind(field)!;
  if (kind === "choice") {
    const norm = { $toLower: { $trim: { input: { $convert: { input: "$$x", to: "string", onError: "", onNull: "" } } } } };
    return { $let: { vars: { v: rawExpr(field) }, in: { $setUnion: [{ $filter: { input: { $map: { input: asArray, as: "x", in: norm } }, as: "s", cond: { $ne: ["$$s", ""] } } }, []] } } };
  }
  if (kind === "number") {
    const src = { $cond: [{ $eq: [{ $type: "$$x" }, "string"] }, { $trim: { input: "$$x" } }, "$$x"] };
    const num = { $convert: { input: src, to: "double", onError: null, onNull: null } };
    return { $let: { vars: { v: rawExpr(field) }, in: { $setUnion: [{ $filter: { input: { $map: { input: asArray, as: "x", in: num } }, as: "n", cond: { $ne: ["$$n", null] } } }, []] } } };
  }
  const date = {
    $switch: {
      branches: [
        { case: { $eq: [{ $type: "$$v" }, "date"] }, then: "$$v" },
        { case: { $eq: [{ $type: "$$v" }, "string"] }, then: { $dateFromString: { dateString: { $trim: { input: "$$v" } }, onError: null, onNull: null } } },
      ],
      default: null,
    },
  };
  // Dates are calendar values, not instants: bucketed in UTC so "2026-10-06" is never moved to the 5th by a timezone.
  return {
    $let: {
      vars: { v: rawExpr(field) },
      in: { $let: { vars: { d: date }, in: { $cond: [{ $eq: ["$$d", null] }, [], [{ $dateToString: { date: "$$d", format: FORMATS[granularity], timezone: "UTC" } }]] } } },
    },
  };
};

const optionKeys = (field: any): string[] => optionLabels(field).map(normKey);

// Mongo predicate (aggregation expression) for "this response is in the segment `value` of the field".
const predicate = (field: any, value: string, granularity: Granularity): any => {
  const vals = valuesExpr(field, granularity);
  if (value === SEGMENT_BLANK) return { $eq: [{ $size: vals }, 0] };
  const kind = fieldKind(field)!;
  if (kind === "choice") {
    if (value === SEGMENT_OTHER) return { $gt: [{ $size: { $setDifference: [vals, { $literal: optionKeys(field) }] } }, 0] };
    const target = normKey(value);
    if (!target) throw new SegmentError(400, "INVALID_FILTER_VALUE", "value must not be empty (use __blank__ for unanswered)");
    return { $in: [{ $literal: target }, vals] };
  }
  if (kind === "number") {
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n)) throw new SegmentError(400, "INVALID_FILTER_VALUE", "value must be a number");
    return { $in: [{ $literal: n }, vals] };
  }
  if (!KEY_RE[granularity].test(value)) {
    const eg = granularity === "day" ? "2026-09-27" : granularity === "week" ? "2026-W39" : "2026-09";
    throw new SegmentError(400, "INVALID_FILTER_VALUE", `value must be a ${granularity} bucket key such as ${eg}`);
  }
  return { $in: [{ $literal: value }, vals] };
};

// The Response filter for `?field=&value=&granularity=`. Throws SegmentError (400) on anything unusable.
export const fieldSegmentFilter = (form: any, fieldId: unknown, value: unknown, granularity?: unknown): any => {
  const field = (form.fields || []).find((f: any) => f.fieldId === fieldId && !f.deleted);
  if (typeof fieldId !== "string" || !field) throw new SegmentError(400, "FIELD_NOT_FOUND", "That question is not on this form");
  if (!fieldKind(field)) throw new SegmentError(400, "FIELD_NOT_CHARTABLE", "That question type cannot be filtered by value");
  if (typeof value !== "string") throw new SegmentError(400, "INVALID_FILTER_VALUE", "value is required with field");
  return { $expr: predicate(field, value, parseGranularity(granularity)) };
};

const pct = (count: number, total: number) => (total ? Math.round((count / total) * 1000) / 10 : 0);

export interface FieldBucket { value: string; label: string; count: number; percentage: number; order: number; other?: boolean }
export interface FieldAggregate {
  fieldId: string;
  fieldType: string;
  total: number; // responses in range that answered this question
  blank: number; // responses in range that did not (filter with value=__blank__)
  totalResponses: number;
  buckets: FieldBucket[];
  granularity?: Granularity;
  stats?: { average: number | null; min: number | null; max: number | null };
  truncated?: boolean;
}

export const aggregateField = async (
  form: any,
  field: any,
  opts: { from?: unknown; to?: unknown; granularity?: Granularity; includeTest?: boolean }
): Promise<FieldAggregate> => {
  const kind = fieldKind(field)!;
  const granularity = opts.granularity ?? "day";
  const match: any = { formId: form._id, deletedAt: null };
  const range = submittedAtRange(opts.from, opts.to);
  if (range) match.submittedAt = range;

  const facet: Record<string, any[]> = {
    all: [{ $count: "n" }],
    answered: [{ $match: { $expr: { $gt: [{ $size: "$vals" }, 0] } } }, { $count: "n" }],
  };
  const keys = optionKeys(field);
  if (kind === "choice") {
    facet.perOption = [{ $unwind: "$vals" }, { $match: { vals: { $in: keys } } }, { $group: { _id: "$vals", count: { $sum: 1 } } }];
    facet.other = [{ $match: { $expr: { $gt: [{ $size: { $setDifference: ["$vals", { $literal: keys }] } }, 0] } } }, { $count: "n" }];
  } else {
    facet.dist = [{ $unwind: "$vals" }, { $group: { _id: "$vals", count: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: MAX_BUCKETS + 1 }];
    if (kind === "number") facet.stats = [{ $unwind: "$vals" }, { $group: { _id: null, avg: { $avg: "$vals" }, min: { $min: "$vals" }, max: { $max: "$vals" } } }];
  }

  const agg = ResponseModel.aggregate([{ $match: match }, { $project: { _id: 0, vals: valuesExpr(field, granularity) } }, { $facet: facet }]).allowDiskUse(true);
  if (opts.includeTest) agg.option({ includeTest: true } as any);
  const [r] = await agg;
  const n = (k: string) => r[k]?.[0]?.n ?? 0;
  const totalResponses = n("all");
  const total = n("answered");
  const out: FieldAggregate = { fieldId: field.fieldId, fieldType: field.type, total, blank: totalResponses - total, totalResponses, buckets: [] };

  if (kind === "choice") {
    const counts = new Map<string, number>((r.perOption as any[]).map((g) => [g._id, g.count]));
    const labels = optionLabels(field);
    out.buckets = labels.map((label, order) => {
      const count = counts.get(normKey(label)) ?? 0;
      return { value: label, label, count, percentage: pct(count, total), order };
    });
    if (n("other") > 0) out.buckets.push({ value: SEGMENT_OTHER, label: "Other", count: n("other"), percentage: pct(n("other"), total), order: labels.length, other: true });
    return out;
  }
  const dist = r.dist as any[];
  out.truncated = dist.length > MAX_BUCKETS;
  out.buckets = dist.slice(0, MAX_BUCKETS).map((g, order) => ({ value: String(g._id), label: String(g._id), count: g.count, percentage: pct(g.count, total), order }));
  if (kind === "date") out.granularity = granularity;
  else {
    const s = r.stats[0];
    out.stats = { average: s ? Math.round(s.avg * 10000) / 10000 : null, min: s ? s.min : null, max: s ? s.max : null };
  }
  return out;
};
