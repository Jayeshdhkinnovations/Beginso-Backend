import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import SavedChart, { CHART_TYPES, CHART_GROUP_BYS, CHART_SIZES, CHART_VISIBILITIES, IChartOptions } from "../models/SavedChart";
import User from "../models/User";
import { resolveFormAccess } from "./form.controller";
import { recordEvent } from "../services/event.service";
import { aggregateField, fieldKind, CHART_TYPES_BY_KIND, parseGranularity, SegmentError, FieldAggregate, Granularity } from "../utils/fieldSegments";

// Sprint 14 (B1.3, OQ-1) + charts v2. Charts are per form AND per user: `private` (default) = only the owner,
// `workspace` = everyone who can read analytics on the form. Read = analytics:read, create/change = forms:write
// (both enforced by the route, which also honours per-form grants); this file adds the personal-form ownership
// check the middleware skips, plus the per-chart rule: edit = the owner, or an admin/owner of the workspace
// for a workspace-visible chart. Someone else's private chart does not exist as far as the caller can tell (404).

const MAX_CHARTS_PER_OWNER = 20;
const DEFAULT_OPTIONS: IChartOptions = { valueMode: "count", legend: true, sort: "order" };

const optionsSchema = z.object({
  valueMode: z.enum(["count", "percent"]).optional(),
  legend: z.boolean().optional(),
  sort: z.enum(["value", "order"]).optional(),
});
const baseShape = {
  chartType: z.enum(CHART_TYPES),
  groupBy: z.enum(CHART_GROUP_BYS).optional(), // legacy Sprint 14 clients
  granularity: z.enum(["day", "week", "month"]).optional(),
  size: z.enum(CHART_SIZES).optional(),
  title: z.string().trim().max(120).optional(),
  options: optionsSchema.optional(),
  visibility: z.enum(CHART_VISIBILITIES).optional(),
};
const createSchema = z.object({ fieldId: z.string().min(1).max(100), ...baseShape });
const patchSchema = z
  .object({ fieldId: z.string().min(1).max(100), ...baseShape, position: z.number().int().min(0).max(100000), order: z.number().int().min(0).max(100000) })
  .partial();
const previewSchema = z.object({ fieldId: z.string().min(1).max(100), chartType: baseShape.chartType, groupBy: baseShape.groupBy, granularity: baseShape.granularity });

const httpError = (res: Response, status: number, message: string, code?: string): void => {
  res.status(status).json({ success: false, message, error: { ...(code ? { code } : {}), message } });
};
const segmentError = (res: Response, e: unknown): boolean => {
  if (!(e instanceof SegmentError)) return false;
  httpError(res, e.statusCode, e.message, e.code);
  return true;
};

// Resolves the form and confirms the caller may reach it. Writes the error response itself and returns null.
const loadForm = async (req: Request, res: Response): Promise<any | null> => {
  const authReq = req as any;
  const formId = String(req.params.formId);
  if (!mongoose.Types.ObjectId.isValid(formId)) {
    httpError(res, 404, "Form not found");
    return null;
  }
  const { formDoc, isAuthorized } = await resolveFormAccess(formId, authReq.user, authReq.formAccessGrant);
  if (!formDoc) {
    httpError(res, 404, "Form not found");
    return null;
  }
  if (!isAuthorized) {
    httpError(res, 403, "Forbidden: You do not have access to this form", "FORBIDDEN_FORM_ACCESS");
    return null;
  }
  return formDoc;
};

const findField = (form: any, fieldId: string): any =>
  (form.fields || []).find((f: any) => f.fieldId === fieldId && !f.deleted);

type Def = { chartType: string; granularity: Granularity | null; groupBy: "value" | "day" | "week" };

// Validates a chart definition against its field and works out the stored granularity. Returns an error message or the def.
const resolveDef = (field: any, chartType: string, granularity?: string | null, groupBy?: string): string | Def => {
  if (!field) return "That question is not on this form";
  const kind = fieldKind(field);
  if (!kind) return "That question type cannot be charted";
  if (!CHART_TYPES_BY_KIND[kind].includes(chartType)) return `A ${field.type} question can be shown as: ${CHART_TYPES_BY_KIND[kind].join(", ")}`;
  // Legacy `groupBy` (only consulted when the client sent no granularity): value for choice/number, day|week for date.
  if (groupBy && !granularity) {
    if (kind !== "date" && groupBy !== "value") return "That question is grouped by value";
    if (kind === "date" && groupBy === "value") return "A date question is grouped by day or week";
  }
  if (kind !== "date") return { chartType, granularity: null, groupBy: "value" };
  const g = (granularity as Granularity | undefined) ?? (groupBy === "week" ? "week" : "day");
  return { chartType, granularity: g, groupBy: g === "week" ? "week" : "day" };
};

const ownerOf = (c: any): string => String(c.ownerId ?? c.createdBy ?? "");

// A stored chart (v2 or Sprint 14) as the v2 shape. Sprint 14 rows: owner = createdBy, visibility = workspace.
const normalise = (c: any, form: any, me: string, isAdmin: boolean, ownerNames: Map<string, string>) => {
  const field = findField(form, c.fieldId);
  const visibility = c.visibility ?? "workspace";
  const owner = ownerOf(c);
  const granularity = c.granularity ?? (c.groupBy === "week" ? "week" : c.groupBy === "day" ? "day" : null);
  const position = c.position ?? c.order ?? 0;
  return {
    _id: String(c._id),
    formId: String(c.formId),
    fieldId: c.fieldId,
    fieldType: field?.type ?? null,
    chartType: c.chartType,
    granularity,
    groupBy: granularity === null ? "value" : granularity === "week" ? "week" : "day", // legacy
    size: c.size ?? "medium",
    title: c.title || field?.label || "Untitled chart",
    options: { ...DEFAULT_OPTIONS, ...(c.options ?? {}) },
    visibility,
    ownerId: owner || null,
    ownerName: ownerNames.get(owner) ?? null,
    isOwner: owner === me,
    canEdit: owner === me || (isAdmin && visibility !== "private"),
    position,
    order: position, // legacy
    // The question was deleted from the form after the chart was made: say so instead of failing.
    fieldMissing: !field,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
};

const ctx = (req: Request) => {
  const authReq = req as any;
  const me = String(authReq.user._id);
  const isAdmin = authReq.user.role === "super_admin" || ["owner", "admin"].includes(authReq.workspaceRole);
  return { me, isAdmin };
};

const visibleToMe = (me: string): any => ({ $or: [{ visibility: { $ne: "private" } }, { ownerId: new mongoose.Types.ObjectId(me) }] });

const present = async (docs: any[], form: any, req: Request) => {
  const { me, isAdmin } = ctx(req);
  const ids = [...new Set(docs.map(ownerOf).filter(Boolean))];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("fullName").lean() : [];
  const names = new Map(users.map((u: any) => [String(u._id), u.fullName as string]));
  return docs.map((d) => normalise(d, form, me, isAdmin, names));
};

// The caller's own charts first (they control that order), then everyone else's workspace charts.
const listFor = async (form: any, req: Request) => {
  const { me } = ctx(req);
  const docs = await SavedChart.find({ formId: form._id, ...visibleToMe(me) }).limit(500).lean();
  const out = await present(docs, form, req);
  const key = (c: any) => [c.isOwner ? 0 : 1, c.position, new Date(c.createdAt).getTime()];
  return out.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
};

// Loads a chart the caller can see (404 otherwise). `edit` additionally requires edit rights (403).
const loadChart = async (req: Request, res: Response, form: any, edit: boolean): Promise<any | null> => {
  const { me, isAdmin } = ctx(req);
  const chartId = String(req.params.chartId);
  const chart = mongoose.Types.ObjectId.isValid(chartId) ? await SavedChart.findOne({ _id: chartId, formId: form._id, ...visibleToMe(me) }) : null;
  if (!chart) {
    httpError(res, 404, "Chart not found");
    return null;
  }
  if (edit && ownerOf(chart) !== me && !(isAdmin && (chart.visibility ?? "workspace") !== "private")) {
    httpError(res, 403, "Only the chart's owner or a workspace admin can change this chart", "FORBIDDEN_CHART");
    return null;
  }
  return chart;
};

const nextPosition = async (form: any, me: string): Promise<{ count: number; next: number }> => {
  const own = await SavedChart.find({ formId: form._id, $or: [{ ownerId: me }, { ownerId: { $exists: false }, createdBy: me }] }).select("position order").lean();
  return { count: own.length, next: own.reduce((m: number, c: any) => Math.max(m, (c.position ?? c.order ?? 0) + 1), 0) };
};

export const listCharts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    res.status(200).json({ success: true, charts: await listFor(form, req) });
  } catch (error) {
    next(error);
  }
};

export const createChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return httpError(res, 400, "Invalid chart definition", "VALIDATION_ERROR");
    const d = parsed.data;
    const field = findField(form, d.fieldId);
    const def = resolveDef(field, d.chartType, d.granularity, d.groupBy);
    if (typeof def === "string") return httpError(res, 400, def, "INVALID_CHART");

    const { me } = ctx(req);
    const { count, next: position } = await nextPosition(form, me);
    if (count >= MAX_CHARTS_PER_OWNER) return httpError(res, 400, `You can have at most ${MAX_CHARTS_PER_OWNER} charts on a form`, "CHART_LIMIT");

    const chart: any = await SavedChart.create({
      formId: form._id,
      workspaceId: form.workspaceId ?? null,
      fieldId: d.fieldId,
      chartType: def.chartType,
      groupBy: def.groupBy,
      granularity: def.granularity,
      createdBy: me,
      ownerId: me,
      // Sprint 14 clients (they send `groupBy`, never `visibility`) always made charts everyone could see.
      visibility: d.visibility ?? (d.groupBy ? "workspace" : "private"),
      size: d.size ?? "medium",
      title: d.title || field.label,
      options: { ...DEFAULT_OPTIONS, ...(d.options ?? {}) },
      position,
      order: position,
    } as any);
    await recordEvent(req, form.workspaceId, "chart.create", { id: chart._id, type: "chart", label: form.title }, { formId: String(form._id), fieldId: d.fieldId });
    const [out] = await present([chart.toObject()], form, req);
    res.status(201).json({ success: true, chart: out });
  } catch (error) {
    next(error);
  }
};

export const updateChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const chart = await loadChart(req, res, form, true);
    if (!chart) return;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return httpError(res, 400, "Invalid chart definition", "VALIDATION_ERROR");
    const d = parsed.data;

    const fieldId = d.fieldId ?? chart.fieldId;
    const field = findField(form, fieldId);
    // Only a change to the definition is re-validated: a title/size/visibility edit must still work on a chart
    // whose question was later deleted.
    const defChanged = d.fieldId !== undefined || d.chartType !== undefined || d.granularity !== undefined || d.groupBy !== undefined;
    if (defChanged) {
      const def = resolveDef(field, d.chartType ?? chart.chartType, d.granularity ?? (d.fieldId ? undefined : chart.granularity ?? (chart.groupBy === "week" ? "week" : undefined)), d.groupBy);
      if (typeof def === "string") return httpError(res, 400, def, "INVALID_CHART");
      chart.set({ fieldId, chartType: def.chartType, granularity: def.granularity, groupBy: def.groupBy });
    }
    if (d.size !== undefined) chart.size = d.size;
    if (d.title !== undefined) chart.title = d.title || field?.label || chart.title;
    if (d.options !== undefined) chart.options = { ...DEFAULT_OPTIONS, ...((chart.options as any)?.toObject?.() ?? chart.options ?? {}), ...d.options };
    if (d.visibility !== undefined) chart.visibility = d.visibility;
    const position = d.position ?? d.order;
    if (position !== undefined) {
      chart.position = position;
      chart.order = position;
    }
    // Sprint 14 rows get their v2 identity written down the first time anyone edits them.
    if (!chart.ownerId) chart.ownerId = chart.createdBy;
    if (!chart.visibility) chart.visibility = "workspace";
    await chart.save();
    const [out] = await present([chart.toObject()], form, req);
    res.status(200).json({ success: true, chart: out });
  } catch (error) {
    next(error);
  }
};

// PUT /charts/order { ids }: the caller's own charts, in the order they should appear. 400 on any id that is not
// one of the caller's own charts on this form (someone else's, another form's, unknown, duplicated).
export const reorderCharts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const parsed = z.object({ ids: z.array(z.string()).max(200) }).safeParse(req.body);
    if (!parsed.success) return httpError(res, 400, "ids must be an array of chart ids", "VALIDATION_ERROR");
    const { ids } = parsed.data;
    const { me } = ctx(req);
    const own = await SavedChart.find({ formId: form._id, $or: [{ ownerId: me }, { ownerId: { $exists: false }, createdBy: me }] }).sort({ position: 1, order: 1, createdAt: 1 }).lean();
    const ownIds = new Set(own.map((c: any) => String(c._id)));
    if (new Set(ids).size !== ids.length || ids.some((id) => !ownIds.has(id))) {
      return httpError(res, 400, "ids must be your own charts on this form, each listed once", "FOREIGN_CHART_IDS");
    }
    const sequence = [...ids, ...own.map((c: any) => String(c._id)).filter((id) => !ids.includes(id))];
    await SavedChart.bulkWrite(sequence.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { position: i, order: i } } } })));
    res.status(200).json({ success: true, charts: await listFor(form, req) });
  } catch (error) {
    next(error);
  }
};

export const duplicateChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const src = await loadChart(req, res, form, false);
    if (!src) return;
    const { me } = ctx(req);
    const { count, next: position } = await nextPosition(form, me);
    if (count >= MAX_CHARTS_PER_OWNER) return httpError(res, 400, `You can have at most ${MAX_CHARTS_PER_OWNER} charts on a form`, "CHART_LIMIT");
    const [view] = await present([src.toObject()], form, req);
    const chart: any = await SavedChart.create({
      formId: form._id,
      workspaceId: form.workspaceId ?? null,
      fieldId: src.fieldId,
      chartType: src.chartType,
      groupBy: view.groupBy,
      granularity: view.granularity,
      createdBy: me,
      ownerId: me,
      visibility: "private", // a copy is the copier's own until they choose to share it
      size: view.size,
      title: `${view.title} (copy)`.slice(0, 120),
      options: view.options,
      position,
      order: position,
    } as any);
    await recordEvent(req, form.workspaceId, "chart.create", { id: chart._id, type: "chart", label: form.title }, { formId: String(form._id), fieldId: src.fieldId, duplicatedFrom: String(src._id) });
    const [out] = await present([chart.toObject()], form, req);
    res.status(201).json({ success: true, chart: out });
  } catch (error) {
    next(error);
  }
};

// Hard delete. Undo is the client re-creating the chart from the payload it still holds (POST /charts).
export const deleteChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const chart = await loadChart(req, res, form, true);
    if (!chart) return;
    await chart.deleteOne();
    await recordEvent(req, form.workspaceId, "chart.delete", { id: chart._id, type: "chart", label: form.title }, { formId: String(form._id) });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Legacy `series` ({label,value}[]) derived from the aggregate; `total` there is the sum of the series (selections).
const legacy = (agg: FieldAggregate) => {
  const series = agg.buckets.map((b) => ({ label: b.label, value: b.count }));
  return { series, total: series.reduce((s, x) => s + x.value, 0), aggregate: agg };
};

export const getChartData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const chart = await loadChart(req, res, form, false);
    if (!chart) return;
    const [view] = await present([chart.toObject()], form, req);
    const field = findField(form, chart.fieldId);
    if (!field || !fieldKind(field)) return void res.status(200).json({ success: true, fieldMissing: true, series: [], total: 0, aggregate: null });
    const agg = await aggregateField(form, field, { from: req.query.from, to: req.query.to, granularity: (view.granularity ?? "day") as Granularity, includeTest: req.query.includeTest === "true" });
    res.status(200).json({ success: true, fieldMissing: false, ...legacy(agg) });
  } catch (error) {
    next(error);
  }
};

export const previewChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) return httpError(res, 400, "Invalid chart definition", "VALIDATION_ERROR");
    const field = findField(form, parsed.data.fieldId);
    const def = resolveDef(field, parsed.data.chartType, parsed.data.granularity, parsed.data.groupBy);
    if (typeof def === "string") return httpError(res, 400, def, "INVALID_CHART");
    const agg = await aggregateField(form, field, { from: req.body?.from ?? req.query.from, to: req.body?.to ?? req.query.to, granularity: def.granularity ?? "day" });
    res.status(200).json({ success: true, fieldMissing: false, ...legacy(agg) });
  } catch (error) {
    next(error);
  }
};

// GET /api/forms/:formId/analytics/field/:fieldId?from=&to=&granularity=&includeTest=
export const getFieldAnalytics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const field = findField(form, String(req.params.fieldId));
    if (!field) return httpError(res, 404, "That question is not on this form", "FIELD_NOT_FOUND");
    if (!fieldKind(field)) return httpError(res, 400, "That question type cannot be charted", "FIELD_NOT_CHARTABLE");
    const granularity = parseGranularity(req.query.granularity);
    const agg = await aggregateField(form, field, { from: req.query.from, to: req.query.to, granularity, includeTest: req.query.includeTest === "true" });
    res.status(200).json({ success: true, ...agg });
  } catch (error) {
    if (!segmentError(res, error)) next(error);
  }
};
