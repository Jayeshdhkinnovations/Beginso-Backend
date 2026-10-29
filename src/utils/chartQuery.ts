import mongoose from "mongoose";
import { z } from "zod";
import ResponseModel from "../models/Response";
import Stage from "../models/Stage";
import Tag from "../models/Tag";
import User from "../models/User";
import { normKey, optionLabels, rawExpr, SegmentError, SEGMENT_BLANK, SEGMENT_OTHER, valuesExpr, withAnswerKey } from "./fieldSegments";

// Charts v3 query engine. A chart is "group the responses by one field, measure each group, after these filters".
// Everything runs inside MongoDB (nothing is pulled into Node memory but the finished groups), and ONE filter builder
// (`filterExpr`, `focusExpr`) serves the chart AND the Responses list (`chart` parameter), so the number on a bar is
// the number of rows the Responses page lists for the same filter. Answers are read by fieldId with the existing fallback
// to the label key (fieldSegments.valuesExpr), and no answer text ever leaves this file except as a group label that is
// one of the form's own options / a number range / a date bucket / a stage, assignee or tag name.

export const SYSTEM_KEYS = ["stage", "assignee", "tags", "submittedAt"] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];
export const BUCKETS = ["day", "week", "month", "year"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const SORTS = ["value_desc", "value_asc", "label_asc", "label_desc", "natural"] as const;
export type Sort = (typeof SORTS)[number];
export const MEASURES = ["count", "sum", "avg", "min", "max"] as const;
export const PALETTES = ["theme", "ocean", "sunset", "forest", "mono"] as const;
export const CHOICE_OPS = ["is", "is_not"] as const;
export const NUMBER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
export const MAX_CONDITIONS = 8;
export const TOP_GROUPS = 12;
const MAX_TIME_GROUPS = 60; // a time series is cut by recency, not by size
const MAX_RANGES = 6;

// ── shape ────────────────────────────────────────────────────────────────────

const fieldRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), fieldId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("system"), key: z.enum(SYSTEM_KEYS) }),
]);
export type FieldRef = z.infer<typeof fieldRef>;

const condition = z.object({
  field: fieldRef,
  op: z.enum([...CHOICE_OPS, ...NUMBER_OPS]),
  value: z.union([z.string().max(200), z.number().finite()]),
});
export type Condition = z.infer<typeof condition>;
const innerGroup = z.object({ op: z.enum(["and", "or"]), items: z.array(condition).max(MAX_CONDITIONS) });
const filterGroup = z.object({ op: z.enum(["and", "or"]), items: z.array(z.union([condition, innerGroup])).max(MAX_CONDITIONS) });
export type FilterGroup = z.infer<typeof filterGroup>;

export const displaySchema = z.object({
  values: z.enum(["counts", "percent"]).default("counts"),
  legend: z.boolean().default(true),
  dataLabels: z.boolean().default(false),
  palette: z.enum(PALETTES).default("theme"),
  interactive: z.boolean().default(true),
});

const measureSchema = z.object({ type: z.enum(MEASURES), field: fieldRef.optional() }).default({ type: "count" });
const simpleSchema = z.object({
  kind: z.literal("simple"),
  measure: measureSchema,
  groupBy: z.object({ field: fieldRef, bucket: z.enum(BUCKETS).optional() }),
  filters: filterGroup.optional(),
  sort: z.enum(SORTS).nullable().optional(),
  display: displaySchema.optional(),
});
export type ChartDef = z.infer<typeof simpleSchema>;

// A drill-down chart: the same measure and filters, grouped by level 1; a click on a part groups that part's responses by level 2, and so on.
export const MIN_LEVELS = 2;
export const MAX_LEVELS = 4;
export const LEVEL_CHART_TYPES = ["bar", "hbar", "donut", "line"] as const;
const levelSchema = z.object({
  field: fieldRef,
  bucket: z.enum(BUCKETS).optional(),
  sort: z.enum(SORTS).nullable().optional(),
  chartType: z.enum(LEVEL_CHART_TYPES).nullable().optional(), // null = the page picks it from the field
});
const drillSchema = z.object({
  kind: z.literal("drilldown"),
  measure: measureSchema,
  levels: z.array(levelSchema).min(MIN_LEVELS).max(MAX_LEVELS),
  filters: filterGroup.optional(),
  display: displaySchema.optional(),
});
export const definitionSchema = z.discriminatedUnion("kind", [simpleSchema, drillSchema]);
export type AnyDef = z.infer<typeof definitionSchema>;

export const focusSchema = z.object({ key: z.string().max(200), lo: z.number().finite().optional(), hi: z.number().finite().optional() });
export type Focus = z.infer<typeof focusSchema>;
/** The parts already clicked, outermost first: `level` is the level that was grouped when the click happened. */
export const pathSchema = z.array(focusSchema.extend({ level: z.number().int().min(0).max(MAX_LEVELS - 1) })).max(MAX_LEVELS - 1);
export type Path = z.infer<typeof pathSchema>;

/** The simple chart that one level of a definition is: what actually gets counted at that depth (before the path narrows it). */
export const levelDef = (def: AnyDef, depth: number): ChartDef => {
  if (def.kind === "simple") return def;
  const l = def.levels[depth];
  return { kind: "simple", measure: def.measure, groupBy: { field: l.field, ...(l.bucket ? { bucket: l.bucket } : {}) }, filters: def.filters, sort: l.sort ?? null, display: def.display };
};
/** The question or system field a chart is first grouped by. */
export const firstField = (def: AnyDef): FieldRef => (def.kind === "simple" ? def.groupBy.field : def.levels[0].field);

// ── fields ───────────────────────────────────────────────────────────────────

export type Cls =
  | { kind: "choice"; field: any; label: string; multi: boolean }
  | { kind: "number" | "rating" | "date" | "hour"; field: any; label: string }
  | { kind: "stage" | "assignee" | "tags" | "time"; label: string };

const CHOICE_TYPES: Record<string, boolean> = { dropdown: false, multiple_choice: true, checkbox: true, yes_no: false };
const SYSTEM_LABEL: Record<SystemKey, string> = { stage: "Stage", assignee: "Assignee", tags: "Tags", submittedAt: "Submitted" };

const refKey = (ref: FieldRef): string => (ref.kind === "question" ? `q:${ref.fieldId}` : `s:${ref.key}`);

/** What a field reference is, or null when it is not on the form / cannot be charted. Question types outside the table are not offered. */
export const classify = (form: any, ref: FieldRef): Cls | null => {
  if (ref.kind === "system") {
    if (ref.key === "submittedAt") return { kind: "time", label: SYSTEM_LABEL.submittedAt };
    return { kind: ref.key, label: SYSTEM_LABEL[ref.key] } as Cls;
  }
  const found = (form.fields || []).find((f: any) => f.fieldId === ref.fieldId && !f.deleted);
  if (!found) return null;
  const withKey = withAnswerKey(form, found);
  const label = String(found.label || "Untitled question");
  if (found.type in CHOICE_TYPES) {
    const shim = found.type === "yes_no" ? { ...withKey, type: "dropdown", options: ["Yes", "No"] } : { ...withKey, type: found.type === "dropdown" ? "dropdown" : "multiple_choice" };
    return { kind: "choice", field: shim, label, multi: CHOICE_TYPES[found.type] };
  }
  if (found.type === "number") return { kind: "number", field: { ...withKey, type: "number" }, label };
  if (found.type === "rating") return { kind: "rating", field: { ...withKey, type: "number" }, label };
  // A date and a date with a time are both days to the chart (a "2026-10-20T14:30" answer is the 20th); only the date part is used.
  if (found.type === "date" || found.type === "datetime") return { kind: "date", field: { ...withKey, type: "date" }, label };
  // A time of day ("14:30") is grouped by the hour it falls in.
  if (found.type === "time") return { kind: "hour", field: withKey, label };
  return null;
};

/** The hour (0 to 23) of a time-of-day answer ("14:30" gives 14), as an array of one number, or none when there is no usable answer. */
export const hoursExpr = (field: any): any => ({
  $let: {
    vars: { m: { $regexFind: { input: { $convert: { input: rawExpr(field), to: "string", onError: "", onNull: "" } }, regex: "^[ ]*([01]?[0-9]|2[0-3]):[0-5][0-9]" } } },
    in: { $cond: [{ $eq: ["$$m", null] }, [], [{ $convert: { input: { $arrayElemAt: ["$$m.captures", 0] }, to: "int", onError: null } }]] },
  },
});

/** "9 AM", "12 PM", "11 PM": how an hour of the day reads on a chart. */
export const hourLabel = (hour: number): string => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;

type NumCls = { kind: "number" | "rating"; field: any; label: string };
const isNumeric = (c: Cls | null): c is NumCls => !!c && (c.kind === "number" || c.kind === "rating");

/** The checks a definition must pass before it runs. Throws SegmentError(400, "INVALID_CHART"). */
export const validateDefinition = (form: any, whole: AnyDef): void => {
  const bad = (msg: string): never => {
    throw new SegmentError(400, "INVALID_CHART", msg);
  };
  if (whole.kind === "drilldown") {
    const seen = new Set<string>();
    whole.levels.forEach((l, i) => {
      const key = refKey(l.field);
      if (seen.has(key)) bad("Each level needs a different field.");
      seen.add(key);
      validateDefinition(form, levelDef(whole, i));
    });
    return;
  }
  const def = whole;
  const group = classify(form, def.groupBy.field);
  if (!group) return void bad("That field is not on this form or cannot be charted.");
  if (group.kind === "date" || group.kind === "time") {
    /* bucket optional (defaults to month) */
  } else if (def.groupBy.bucket) bad("Date grouping only applies to dates.");

  const m = def.measure;
  if (m.type === "count") {
    if (m.field) bad("Count of responses does not take a field.");
  } else {
    if (!m.field) bad("Choose the number field to measure.");
    else if (!isNumeric(classify(form, m.field))) bad("Sum, average, minimum and maximum need a number or rating field.");
  }

  let conditions = 0;
  const check = (c: Condition) => {
    conditions += 1;
    const cls = classify(form, c.field);
    if (!cls) return void bad("A filter uses a field that is not on this form.");
    validateCondition(cls, c, bad);
  };
  for (const item of def.filters?.items ?? []) {
    if ("field" in item) check(item);
    else item.items.forEach(check);
  }
  if (conditions > MAX_CONDITIONS) bad(`A chart can have at most ${MAX_CONDITIONS} filters.`);
};

const validateCondition = (cls: Cls, c: Condition, bad: (m: string) => never): void => {
  const isChoiceOp = (CHOICE_OPS as readonly string[]).includes(c.op);
  const isNumOp = (NUMBER_OPS as readonly string[]).includes(c.op);
  if (cls.kind === "choice" || cls.kind === "stage" || cls.kind === "assignee" || cls.kind === "tags") {
    if (!isChoiceOp) bad("Choose “is” or “is not” for this field.");
    if (typeof c.value !== "string" || c.value === "") bad("Choose a value for every filter.");
    return;
  }
  if (cls.kind === "number" || cls.kind === "rating" || cls.kind === "time") {
    if (!isNumOp) bad("Choose a comparison such as “is greater than” for this field.");
    if (typeof c.value !== "number") bad("This filter needs a number.");
    return;
  }
  if (cls.kind === "hour") bad("A time of day cannot be used in a filter.");
  bad("Dates can be filtered by year only (use the Submitted year).");
};

// ── value expressions (per response) ─────────────────────────────────────────

const TZ_FALLBACK = "UTC";
export const resolveTimezone = (tz: unknown): string => {
  if (typeof tz !== "string" || !tz) return TZ_FALLBACK;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return TZ_FALLBACK;
  }
};

const FORMATS: Record<Bucket, string> = { day: "%Y-%m-%d", week: "%G-W%V", month: "%Y-%m", year: "%Y" };
const submittedDate = { $ifNull: ["$submittedAt", "$createdAt"] };

/** Array of the keys (strings) one response falls under for this field. Numbers are kept as numbers; number ranges are applied by the caller. */
const keysExpr = (cls: Cls, bucket: Bucket, tz: string): any => {
  switch (cls.kind) {
    case "choice":
    case "number":
    case "rating":
      return valuesExpr(cls.field);
    case "date":
      return valuesExpr(cls.field, bucket as any);
    case "hour":
      return hoursExpr(cls.field);
    case "time":
      return [{ $dateToString: { date: submittedDate, format: FORMATS[bucket], timezone: tz } }];
    case "stage":
      return { $cond: [{ $ifNull: ["$stageId", false] }, [{ $toString: "$stageId" }], []] };
    case "assignee":
      return { $cond: [{ $ifNull: ["$assigneeId", false] }, [{ $toString: "$assigneeId" }], []] };
    case "tags":
      return { $map: { input: { $ifNull: ["$tagIds", []] }, as: "t", in: { $toString: "$$t" } } };
  }
};

// ── filters ──────────────────────────────────────────────────────────────────

const NUM_CMP: Record<string, string> = { gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte" };

const conditionExpr = (form: any, c: Condition, tz: string): any => {
  const cls = classify(form, c.field)!;
  const value = c.value;
  if (cls.kind === "choice") {
    const has = { $in: [{ $literal: normKey(value) }, valuesExpr(cls.field)] };
    return c.op === "is" ? has : { $not: [has] };
  }
  if (cls.kind === "stage" || cls.kind === "assignee") {
    const path = cls.kind === "stage" ? "$stageId" : "$assigneeId";
    const eq = { $eq: [{ $toString: { $ifNull: [path, ""] } }, String(value)] };
    return c.op === "is" ? eq : { $not: [eq] };
  }
  if (cls.kind === "tags") {
    const has = { $in: [String(value), { $map: { input: { $ifNull: ["$tagIds", []] }, as: "t", in: { $toString: "$$t" } } }] };
    return c.op === "is" ? has : { $not: [has] };
  }
  // numeric comparisons: "any value the response gave" (a response with no value is not equal to anything)
  const numbers = cls.kind === "time" ? [{ $year: { date: submittedDate, timezone: tz } }] : valuesExpr((cls as any).field);
  const n = Number(value);
  if (c.op === "eq") return { $in: [n, numbers] };
  if (c.op === "neq") return { $not: [{ $in: [n, numbers] }] };
  return { $gt: [{ $size: { $filter: { input: numbers, as: "n", cond: { [NUM_CMP[c.op]]: ["$$n", n] } } } }, 0] };
};

/** The filter tree as one aggregation expression (true when there are no filters). */
export const filterExpr = (form: any, filters: FilterGroup | undefined, tz: string): any => {
  if (!filters || filters.items.length === 0) return true;
  const part = (item: Condition | z.infer<typeof innerGroup>): any => ("field" in item ? conditionExpr(form, item, tz) : join(item.op, item.items.map((i) => conditionExpr(form, i, tz))));
  return join(filters.op, filters.items.map(part));
};
const join = (op: "and" | "or", parts: any[]): any => (parts.length === 0 ? true : op === "and" ? { $and: parts } : { $or: parts });

/** "This response is in the group `focus` of the chart's groupBy field": what a click on a bar means. */
export const focusExpr = (form: any, def: ChartDef, focus: Focus, tz: string): any => {
  const cls = classify(form, def.groupBy.field);
  if (!cls) return false;
  const bucket = def.groupBy.bucket ?? "month";
  if (focus.key === SEGMENT_BLANK) return { $eq: [{ $size: numericOrKeys(cls, bucket, tz) }, 0] };
  if (cls.kind === "choice" && focus.key === SEGMENT_OTHER) {
    const known = optionLabels(cls.field).map(normKey);
    return { $gt: [{ $size: { $setDifference: [valuesExpr(cls.field), { $literal: known }] } }, 0] };
  }
  if (cls.kind === "number") {
    const lo = focus.lo ?? Number(focus.key);
    return { $gt: [{ $size: { $filter: { input: valuesExpr(cls.field), as: "n", cond: { $and: [{ $gte: ["$$n", lo] }, ...(focus.hi !== undefined ? [{ $lt: ["$$n", focus.hi] }] : [])] } } } }, 0] };
  }
  if (cls.kind === "rating") return { $in: [Number(focus.key), valuesExpr(cls.field)] };
  if (cls.kind === "hour") return { $in: [Number(focus.key), hoursExpr(cls.field)] };
  const target = cls.kind === "choice" ? normKey(focus.key) : focus.key;
  return { $in: [{ $literal: target }, keysExpr(cls, bucket, tz)] };
};
const numericOrKeys = (cls: Cls, bucket: Bucket, tz: string): any => keysExpr(cls, bucket, tz);

/** The `chart` parameter of the Responses list: the chart's own filters, optionally narrowed to one group. Same builder as the chart. */
export const chartListFilter = (form: any, raw: unknown, tz: string): any => {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new SegmentError(400, "INVALID_CHART_FILTER", "chart must be JSON");
  }
  const spec = z.object({ definition: definitionSchema, path: pathSchema.optional(), focus: focusSchema.optional() }).safeParse(parsed);
  if (!spec.success) throw new SegmentError(400, "INVALID_CHART_FILTER", "chart is not a valid chart filter");
  const { definition, path = [], focus } = spec.data;
  validateDefinition(form, definition);
  const depth = checkPath(definition, path);
  const parts = [filterExpr(form, definition.filters, tz), ...pathExprs(form, definition, path, tz)];
  if (focus) parts.push(focusExpr(form, levelDef(definition, depth), focus, tz));
  return { $expr: { $and: parts } };
};

/** The path must walk the levels in order and stop before the last one (the last level is where the click lands). Returns the depth being shown. */
export const checkPath = (def: AnyDef, path: Path): number => {
  const levels = def.kind === "drilldown" ? def.levels.length : 1;
  if (path.length > levels - 1 || path.some((p, i) => p.level !== i)) throw new SegmentError(400, "INVALID_CHART_PATH", "That drill-down path does not fit this chart.");
  return path.length;
};
/** One condition per part already clicked, each read against the level it was clicked on. */
export const pathExprs = (form: any, def: AnyDef, path: Path, tz: string): any[] => path.map((p, i) => focusExpr(form, levelDef(def, i), p, tz));

// ── running a chart ──────────────────────────────────────────────────────────

export interface Entry {
  key: string;
  label: string;
  value: number;
  n: number;
  share: number;
  focus: Focus;
}
export interface ChartResult {
  level: { field: FieldRef; label: string; kind: Cls["kind"]; bucket?: Bucket };
  fieldType: string | null;
  optionCount: number | null;
  measure: { type: (typeof MEASURES)[number]; label: string; field?: FieldRef; fieldLabel?: string };
  total: number;
  answered: number;
  blank: number;
  blankLabel: string;
  measureAnswered: number | null;
  entries: Entry[];
  shown: number;
  totalGroups: number;
  /** Drill-down: which level this is (0 = the first) and how many there are. A simple chart is 0 of 1. */
  depth: number;
  levelCount: number;
  nextLevel: { field: FieldRef; label: string; bucket?: Bucket } | null;
  warnings: { code: string; message: string }[];
  computedAt: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const bucketLabel = (key: string, bucket: Bucket): string => {
  if (bucket === "year") return key;
  if (bucket === "month") {
    const [y, m] = key.split("-");
    return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  if (bucket === "week") {
    const [y, w] = key.split("-W");
    return `Week ${Number(w)}, ${y}`;
  }
  const [y, m, d] = key.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
};

/** "Nice" ranges for a number field: about five equal steps of 1, 2, 5 x 10^k covering [min, max]. */
export const niceRanges = (min: number, max: number): { start: number; step: number; count: number } => {
  if (!(max > min)) return { start: Math.floor(min), step: 1, count: 1 };
  const raw = (max - min) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  let count = Math.max(1, Math.ceil((max - start) / step));
  if (start + count * step <= max) count += 1; // max itself must fall inside the last range
  return { start, step, count: Math.min(count, MAX_RANGES + 2) };
};
const fmt = (n: number): string => String(Math.round(n * 1e6) / 1e6);
const rangeLabel = (lo: number, hi: number, integer: boolean): string => (integer ? `${fmt(lo)}–${fmt(hi - 1)}` : `${fmt(lo)}–${fmt(hi)}`);

const round = (n: number) => Math.round(n * 10000) / 10000;

interface RunOptions {
  tz: string;
  maxTimeMS?: number;
  /** Drill-down: the parts already clicked. */
  path?: Path;
}

export const runChart = async (form: any, whole: AnyDef, opts: RunOptions): Promise<ChartResult> => {
  validateDefinition(form, whole);
  const path = opts.path ?? [];
  const depth = checkPath(whole, path);
  const def = levelDef(whole, depth);
  const cls = classify(form, def.groupBy.field)!;
  const next = whole.kind === "drilldown" && depth + 1 < whole.levels.length ? whole.levels[depth + 1] : null;
  const nextCls = next ? classify(form, next.field) : null;
  const warnings: ChartResult["warnings"] = [];
  const isTime = cls.kind === "date" || cls.kind === "time";
  let bucket: Bucket = def.groupBy.bucket ?? "month";
  const match: any = { formId: form._id, deletedAt: null };
  const tree = filterExpr(form, def.filters, opts.tz);
  const narrowed = pathExprs(form, whole, path, opts.tz);
  if (narrowed.length) match.$expr = { $and: [tree, ...narrowed] };
  else if (tree !== true) match.$expr = tree;

  const measure = def.measure;
  const measureCls = measure.field ? (classify(form, measure.field) as NumCls) : null;
  const run = (pipeline: any[]) => ResponseModel.aggregate(pipeline).allowDiskUse(true).option({ maxTimeMS: opts.maxTimeMS ?? 5000 } as any);

  // number fields: five nice ranges, worked out from the smallest and largest value under the same filters
  let ranges: { start: number; step: number; count: number; integer: boolean } | null = null;
  if (cls.kind === "number") {
    const [mm] = await run([{ $match: match }, { $project: { _id: 0, g: valuesExpr(cls.field) } }, { $unwind: "$g" }, { $group: { _id: null, min: { $min: "$g" }, max: { $max: "$g" } } }]);
    ranges = mm ? { ...niceRanges(mm.min, mm.max), integer: Number.isInteger(mm.min) && Number.isInteger(mm.max) } : null;
  }

  const buildPipeline = (b: Bucket) => {
    const g = keysExpr(cls, b, opts.tz);
    const project: any = { _id: 0, g };
    if (ranges) {
      project.g = { $setUnion: [{ $map: { input: g, as: "x", in: { $toString: { $floor: { $divide: [{ $subtract: ["$$x", ranges.start] }, ranges.step] } } } } }, []] };
    }
    if (measureCls) project.mv = { $ifNull: [{ $arrayElemAt: [valuesExpr(measureCls.field), 0] }, null] }; // $arrayElemAt of nothing is "missing", which $ne null would count
    const accumulators: any = { n: { $sum: 1 } };
    if (measureCls) {
      accumulators.cnt = { $sum: { $cond: [{ $ne: ["$mv", null] }, 1, 0] } };
      accumulators.sum = { $sum: "$mv" };
      accumulators.min = { $min: "$mv" };
      accumulators.max = { $max: "$mv" };
    }
    const facet: Record<string, any[]> = {
      all: [{ $count: "n" }],
      answered: [{ $match: { $expr: { $gt: [{ $size: "$g" }, 0] } } }, { $count: "n" }],
      groups: [{ $unwind: "$g" }, { $group: { _id: "$g", ...accumulators } }, { $limit: 5000 }],
    };
    if (measureCls) facet.measured = [{ $match: { mv: { $ne: null } } }, { $count: "n" }];
    if (cls.kind === "choice") {
      const known = optionLabels(cls.field).map(normKey);
      facet.other = [{ $match: { $expr: { $gt: [{ $size: { $setDifference: ["$g", { $literal: known }] } }, 0] } } }, { $count: "n" }];
    }
    return [{ $match: match }, { $project: project }, { $facet: facet }];
  };

  let [r] = await run(buildPipeline(bucket));
  if (cls.kind === "time" || cls.kind === "date") {
    if (bucket === "day" && (r.groups?.length ?? 0) > 366) {
      bucket = "week";
      warnings.push({ code: "date_grouping_changed", message: "There are more than a year of days, so the chart is grouped by week." });
      [r] = await run(buildPipeline(bucket));
    }
  }

  const count = (k: string) => r[k]?.[0]?.n ?? 0;
  const total = count("all");
  const answered = count("answered");
  const groups = new Map<string, any>((r.groups as any[]).map((x) => [String(x._id), x]));
  const raw: { key: string; label: string; value: number; n: number; order: number; focus: Focus; other?: boolean }[] = [];
  const valueOf = (x: any): number | null => {
    switch (measure.type) {
      case "count":
        return x.n;
      case "sum":
        return round(x.sum ?? 0);
      case "avg":
        return x.cnt > 0 ? round(x.sum / x.cnt) : null;
      case "min":
        return x.cnt > 0 ? x.min : null;
      case "max":
        return x.cnt > 0 ? x.max : null;
    }
  };
  const push = (key: string, label: string, x: any, order: number, focus: Focus, other = false) => {
    const value = valueOf(x);
    if (value === null) return; // an average of nothing is not zero
    raw.push({ key, label, value, n: x.n, order, focus, other });
  };
  const empty = { n: 0, cnt: 0, sum: 0, min: null, max: null };

  let blankLabel = "didn't answer";
  if (cls.kind === "choice") {
    const labels = optionLabels(cls.field);
    labels.forEach((label, i) => push(label, label, groups.get(normKey(label)) ?? empty, i, { key: label }));
    if (count("other") > 0) push(SEGMENT_OTHER, "Other", { ...empty, n: count("other") }, labels.length, { key: SEGMENT_OTHER }, true);
  } else if (cls.kind === "rating") {
    [...groups.keys()].map(Number).sort((a, b) => a - b).forEach((v, i) => push(String(v), String(v), groups.get(String(v)), i, { key: String(v) }));
    if (total - answered > 0) {
      // "Not scored" is a group of its own for a rating
      const blank = await run([{ $match: match }, { $project: { _id: 0, g: valuesExpr(cls.field), ...(measureCls ? { mv: { $ifNull: [{ $arrayElemAt: [valuesExpr(measureCls.field), 0] }, null] } } : {}) } }, { $match: { $expr: { $eq: [{ $size: "$g" }, 0] } } }, { $group: { _id: null, n: { $sum: 1 }, cnt: { $sum: { $cond: [{ $ne: ["$mv", null] }, 1, 0] } }, sum: { $sum: "$mv" }, min: { $min: "$mv" }, max: { $max: "$mv" } } }]);
      if (blank[0]) push(SEGMENT_BLANK, "Not scored", blank[0], 9999, { key: SEGMENT_BLANK });
      blankLabel = "not scored";
    }
  } else if (cls.kind === "hour") {
    // only the hours somebody gave, earliest first (a form is rarely answered at every hour of the day)
    [...groups.keys()].map(Number).sort((a, b) => a - b).forEach((h) => push(String(h), hourLabel(h), groups.get(String(h)), h, { key: String(h) }));
  } else if (cls.kind === "number" && ranges) {
    for (let i = 0; i < ranges.count; i++) {
      const lo = ranges.start + i * ranges.step;
      const hi = lo + ranges.step;
      push(String(i), rangeLabel(lo, hi, ranges.integer && ranges.step >= 1), groups.get(String(i)) ?? empty, i, { key: String(lo), lo, hi });
    }
  } else if (isTime) {
    [...groups.keys()].sort().forEach((k, i) => push(k, bucketLabel(k, bucket), groups.get(k), i, { key: k }));
  } else if (cls.kind === "stage") {
    const stages = await Stage.find({ _id: { $in: [...groups.keys()].filter((k) => mongoose.Types.ObjectId.isValid(k)) } }).select("name order").lean();
    const byId = new Map(stages.map((s: any) => [String(s._id), s]));
    [...groups.keys()].forEach((k) => push(k, (byId.get(k) as any)?.name ?? "Removed stage", groups.get(k), (byId.get(k) as any)?.order ?? 9999, { key: k }));
    blankLabel = "have no stage";
  } else if (cls.kind === "assignee") {
    const users = await User.find({ _id: { $in: [...groups.keys()].filter((k) => mongoose.Types.ObjectId.isValid(k)) } }).select("fullName").lean();
    const byId = new Map(users.map((u: any) => [String(u._id), u.fullName as string]));
    [...groups.keys()].forEach((k) => push(k, byId.get(k) ?? "Former member", groups.get(k), 0, { key: k }));
    blankLabel = "are not assigned";
  } else if (cls.kind === "tags") {
    const tags = await Tag.find({ _id: { $in: [...groups.keys()].filter((k) => mongoose.Types.ObjectId.isValid(k)) } }).select("name").lean();
    const byId = new Map(tags.map((t: any) => [String(t._id), t.name as string]));
    [...groups.keys()].forEach((k) => push(k, byId.get(k) ?? "Removed tag", groups.get(k), 0, { key: k }));
    blankLabel = "have no tag";
  }

  // sort, then the top groups (a time series keeps its latest groups instead)
  const sort: Sort = def.sort ?? defaultSort(cls);
  const cmpLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
  const sorters: Record<Sort, (a: (typeof raw)[number], b: (typeof raw)[number]) => number> = {
    value_desc: (a, b) => b.value - a.value || cmpLabel(a, b),
    value_asc: (a, b) => a.value - b.value || cmpLabel(a, b),
    label_asc: cmpLabel,
    label_desc: (a, b) => cmpLabel(b, a),
    natural: (a, b) => a.order - b.order || cmpLabel(a, b),
  };
  const ordered = [...raw].sort((a, b) => (a.other ? 1 : b.other ? -1 : sorters[sort](a, b)));
  const totalGroups = ordered.length;
  const limit = isTime ? MAX_TIME_GROUPS : TOP_GROUPS;
  const kept = totalGroups > limit ? (isTime && sort === "natural" ? ordered.slice(-limit) : ordered.slice(0, limit)) : ordered;
  if (totalGroups > limit) warnings.push({ code: "top_groups", message: `Showing ${isTime ? "the latest" : "top"} ${limit} of ${totalGroups}` });

  // share: of respondents for a count (a multiple-choice respondent counts in every option), of the total for a sum
  const sumValues = raw.reduce((s, e) => s + e.value, 0);
  const entries: Entry[] = kept.map((e) => ({
    key: e.key,
    label: e.label,
    value: e.value,
    n: e.n,
    share: measure.type === "count" ? (answered ? round(e.n / answered) : 0) : measure.type === "sum" && sumValues ? round(e.value / sumValues) : 0,
    focus: e.focus,
  }));

  return {
    level: { field: def.groupBy.field, label: cls.label, kind: cls.kind, ...(isTime ? { bucket } : {}) },
    fieldType: def.groupBy.field.kind === "question" ? (form.fields || []).find((f: any) => f.fieldId === (def.groupBy.field as any).fieldId)?.type ?? null : def.groupBy.field.key,
    optionCount: cls.kind === "choice" ? optionLabels(cls.field).length : null,
    measure: {
      type: measure.type,
      label: { count: "Responses", sum: "Sum", avg: "Average", min: "Minimum", max: "Maximum" }[measure.type],
      ...(measure.field ? { field: measure.field, fieldLabel: measureCls?.label } : {}),
    },
    total,
    answered,
    blank: total - answered,
    blankLabel,
    measureAnswered: measureCls ? count("measured") : null,
    entries,
    shown: entries.length,
    totalGroups,
    depth,
    levelCount: whole.kind === "drilldown" ? whole.levels.length : 1,
    nextLevel: next && nextCls ? { field: next.field, label: nextCls.label, ...(next.bucket ? { bucket: next.bucket } : {}) } : null,
    warnings,
    computedAt: new Date().toISOString(),
  };
};

const defaultSort = (cls: Cls): Sort => (cls.kind === "choice" || cls.kind === "stage" || cls.kind === "assignee" || cls.kind === "tags" ? "value_desc" : "natural");

/** A saved chart whose field was removed or changed type: a warning, never an error. */
export const fieldWarning = (form: any, def: AnyDef, snapshotType?: string | null): { code: string; message: string } | null => {
  const refs = def.kind === "simple" ? [def.groupBy.field] : def.levels.map((l) => l.field);
  for (const ref of refs) {
    if (ref.kind !== "question") continue;
    const f = (form.fields || []).find((x: any) => x.fieldId === ref.fieldId);
    if (!f || f.deleted) return { code: "field_removed", message: "This chart uses a question that was removed. Edit or remove it." };
    if (snapshotType && refs.length === 1 && f.type !== snapshotType) return { code: "field_changed", message: "The question this chart uses changed type. Edit the chart." };
  }
  return null;
};

export const emptyResult = (def: AnyDef, warning: { code: string; message: string }): ChartResult => ({
  level: { field: firstField(def), label: "", kind: "choice" },
  fieldType: null,
  optionCount: null,
  measure: { type: def.measure.type, label: "" },
  total: 0,
  answered: 0,
  blank: 0,
  blankLabel: "didn't answer",
  measureAnswered: null,
  entries: [],
  shown: 0,
  totalGroups: 0,
  depth: 0,
  levelCount: def.kind === "drilldown" ? def.levels.length : 1,
  nextLevel: null,
  warnings: [warning],
  computedAt: new Date().toISOString(),
});

export { refKey };
