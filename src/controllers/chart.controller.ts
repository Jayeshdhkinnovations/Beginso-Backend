import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import SavedChart, { CHART_TYPES, CHART_GROUP_BYS, ChartType, ChartGroupBy } from "../models/SavedChart";
import ResponseModel from "../models/Response";
import { resolveFormAccess } from "./form.controller";
import { submittedAtRange } from "../utils/dateRange";
import { recordEvent } from "../services/event.service";

// Sprint 14 (B1.3, OQ-1, cut line #1). User-added charts on a form's Insights page.
// Permission: the ROUTE runs requirePermission (analytics:read to read, forms:write to change), which also
// honours per-form grants; this file adds the personal-form ownership check the middleware deliberately skips.

const CHOICE_TYPES = ["dropdown", "multiple_choice", "checkbox"];

const definitionSchema = z.object({
  fieldId: z.string().min(1).max(100),
  chartType: z.enum(CHART_TYPES),
  groupBy: z.enum(CHART_GROUP_BYS),
});

const httpError = (res: Response, status: number, message: string, code?: string): void => {
  res.status(status).json({ success: false, message, error: { ...(code ? { code } : {}), message } });
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

// Only choice fields (bar/donut by value) and date fields (line by day/week) can be charted, and only in
// those combinations. Returns an error message, or null when valid.
const validateDefinition = (field: any, chartType: ChartType, groupBy: ChartGroupBy): string | null => {
  if (!field) return "That question is not on this form";
  if (CHOICE_TYPES.includes(field.type)) {
    if (chartType === "line") return "A choice question can be shown as a bar or donut chart";
    if (groupBy !== "value") return "A choice question is grouped by value";
    return null;
  }
  if (field.type === "date") {
    if (chartType !== "line") return "A date question can be shown as a line chart";
    if (groupBy === "value") return "A date question is grouped by day or week";
    return null;
  }
  return "That question type cannot be charted";
};

const serialise = (chart: any, form: any) => ({
  _id: chart._id.toString(),
  fieldId: chart.fieldId,
  chartType: chart.chartType,
  groupBy: chart.groupBy,
  order: chart.order,
  // The question was deleted from the form after the chart was made: say so instead of failing.
  fieldMissing: !findField(form, chart.fieldId),
});

const readAnswer = (answers: Record<string, any> | undefined, field: any): any => {
  if (!answers || typeof answers !== "object") return undefined;
  const keys = [field.fieldId, field.label, field.label && String(field.label).trim(), field._id && String(field._id)];
  for (const key of keys) {
    if (key && answers[key] !== undefined) return answers[key];
  }
  return undefined;
};

// ISO week label, same shape the trends endpoint uses ("2026-W41").
const isoWeekLabel = (d: Date): string => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const buildSeries = async (
  form: any,
  def: { fieldId: string; groupBy: ChartGroupBy },
  from: unknown,
  to: unknown
): Promise<{ series: { label: string; value: number }[]; total: number }> => {
  const field = findField(form, def.fieldId);
  if (!field) return { series: [], total: 0 };

  const match: any = { formId: form._id, deletedAt: null }; // the Response hook drops isTest
  const range = submittedAtRange(from, to);
  if (range) match.submittedAt = range;

  const counts = new Map<string, number>();
  const isChoice = CHOICE_TYPES.includes(field.type);
  if (isChoice) for (const opt of field.options || []) counts.set(String(opt), 0);

  let total = 0;
  // ponytail: streams every matching response's answers through Node; move to a $group on a stored per-field
  // projection if a single form ever holds enough responses for this to show up in the load test.
  for await (const r of ResponseModel.find(match).select({ answers: 1 }).lean().cursor()) {
    const val = readAnswer((r as any).answers, field);
    if (val === undefined || val === null || val === "") continue;
    if (isChoice) {
      const items = Array.isArray(val) ? val : [val];
      for (const item of items) {
        const str = String(item).trim();
        if (!str) continue;
        const key = [...counts.keys()].find((k) => k.toLowerCase() === str.toLowerCase()) ?? str;
        counts.set(key, (counts.get(key) || 0) + 1);
        total++;
      }
    } else {
      const d = new Date(String(val));
      if (isNaN(d.getTime())) continue;
      const label = def.groupBy === "week" ? isoWeekLabel(d) : d.toISOString().slice(0, 10);
      counts.set(label, (counts.get(label) || 0) + 1);
      total++;
    }
  }

  const entries = [...counts.entries()];
  if (!isChoice) entries.sort((a, b) => a[0].localeCompare(b[0]));
  return { series: entries.map(([label, value]) => ({ label, value })), total };
};

export const listCharts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const charts = await SavedChart.find({ formId: form._id }).sort({ order: 1, createdAt: 1 });
    res.status(200).json({ success: true, charts: charts.map((c) => serialise(c, form)) });
  } catch (error) {
    next(error);
  }
};

export const createChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const parsed = definitionSchema.safeParse(req.body);
    if (!parsed.success) return httpError(res, 400, "Invalid chart definition", "VALIDATION_ERROR");
    const { fieldId, chartType, groupBy } = parsed.data;
    const bad = validateDefinition(findField(form, fieldId), chartType, groupBy);
    if (bad) return httpError(res, 400, bad, "INVALID_CHART");

    const count = await SavedChart.countDocuments({ formId: form._id });
    if (count >= 20) return httpError(res, 400, "A form can have at most 20 saved charts", "CHART_LIMIT");

    const chart = await SavedChart.create({
      formId: form._id,
      workspaceId: form.workspaceId ?? null,
      fieldId,
      chartType,
      groupBy,
      createdBy: (req as any).user._id,
      order: count,
    });
    await recordEvent(req, form.workspaceId, "chart.create", { id: chart._id, type: "chart", label: form.title }, { formId: String(form._id), fieldId });
    res.status(201).json({ success: true, chart: serialise(chart, form) });
  } catch (error) {
    next(error);
  }
};

export const updateChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const chartId = String(req.params.chartId);
    const chart = mongoose.Types.ObjectId.isValid(chartId) ? await SavedChart.findOne({ _id: chartId, formId: form._id }) : null;
    if (!chart) return httpError(res, 404, "Chart not found");

    const parsed = definitionSchema.partial().extend({ order: z.number().int().min(0).max(1000).optional() }).safeParse(req.body);
    if (!parsed.success) return httpError(res, 400, "Invalid chart definition", "VALIDATION_ERROR");
    const merged = {
      fieldId: parsed.data.fieldId ?? chart.fieldId,
      chartType: parsed.data.chartType ?? chart.chartType,
      groupBy: parsed.data.groupBy ?? chart.groupBy,
    };
    const bad = validateDefinition(findField(form, merged.fieldId), merged.chartType, merged.groupBy);
    if (bad) return httpError(res, 400, bad, "INVALID_CHART");

    chart.set(merged);
    if (parsed.data.order !== undefined) chart.order = parsed.data.order;
    await chart.save();
    res.status(200).json({ success: true, chart: serialise(chart, form) });
  } catch (error) {
    next(error);
  }
};

export const deleteChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const chartId = String(req.params.chartId);
    const removed = mongoose.Types.ObjectId.isValid(chartId)
      ? await SavedChart.findOneAndDelete({ _id: chartId, formId: form._id })
      : null;
    if (!removed) return httpError(res, 404, "Chart not found");
    await recordEvent(req, form.workspaceId, "chart.delete", { id: removed._id, type: "chart", label: form.title }, { formId: String(form._id) });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const getChartData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const chartId = String(req.params.chartId);
    const chart = mongoose.Types.ObjectId.isValid(chartId) ? await SavedChart.findOne({ _id: chartId, formId: form._id }) : null;
    if (!chart) return httpError(res, 404, "Chart not found");
    const result = await buildSeries(form, chart, req.query.from, req.query.to);
    res.status(200).json({ success: true, fieldMissing: !findField(form, chart.fieldId), ...result });
  } catch (error) {
    next(error);
  }
};

export const previewChart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const parsed = definitionSchema.safeParse(req.body);
    if (!parsed.success) return httpError(res, 400, "Invalid chart definition", "VALIDATION_ERROR");
    const bad = validateDefinition(findField(form, parsed.data.fieldId), parsed.data.chartType, parsed.data.groupBy);
    if (bad) return httpError(res, 400, bad, "INVALID_CHART");
    const from = req.body?.from ?? req.query.from;
    const to = req.body?.to ?? req.query.to;
    const result = await buildSeries(form, parsed.data, from, to);
    res.status(200).json({ success: true, fieldMissing: false, ...result });
  } catch (error) {
    next(error);
  }
};
