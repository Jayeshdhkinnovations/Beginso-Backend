import { Request, Response, NextFunction } from "express";
import { recordEvent } from "../services/event.service";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import { z } from "zod";
import ReportModel from "../models/Report";
import Form from "../models/Form";
import { getVerifiedWorkspaceId } from "../utils/requestContext";
import { kickReportQueue } from "../services/reportQueue";
import { countReportRows } from "../services/report.service";
import { userHasAccessToForm } from "../utils/formAccess";
import { fieldSegmentFilter, SegmentError } from "../utils/fieldSegments";

const reportCreateSchema = z.object({
  format: z.enum(["csv", "pdf"]),
  formId: z.string().optional(),
  status: z.enum(["new", "in_progress", "completed"]).optional(),
  stageId: z.string().optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  // Sprint 12, BE 0.2 (B2.11): the same filter shape the list/bulk endpoints accept, or an
  // explicit id list, in place of the old single `status` param.
  tagIds: z.array(z.string()).optional(),
  assigneeId: z.string().optional(),
  unread: z.boolean().optional(),
  duplicate: z.boolean().optional(),
  ids: z.array(z.string()).optional(),
  // Charts v2: export one chart segment (needs formId).
  field: z.string().optional(),
  value: z.string().optional(),
  granularity: z.string().optional(),
});

const getWorkspaceId = async (req: Request): Promise<string | null> => {
  const workspaceId = await getVerifiedWorkspaceId(req);
  return workspaceId || null;
};

const purgeExpiredReportFiles = async (workspaceId: string): Promise<void> => {
  const expired = await ReportModel.find({
    workspaceId,
    expiresAt: { $lt: new Date() },
    filePath: { $exists: true, $ne: null },
  }).select("filePath");
  const root = path.resolve(process.cwd(), "uploads");
  for (const r of expired) {
    const file = path.resolve(String(r.filePath));
    if (file.startsWith(root + path.sep)) fs.rmSync(file, { force: true });
    await ReportModel.updateOne({ _id: r._id }, { $unset: { filePath: 1 } });
  }
};

/**
 * POST /api/reports
 * Creates a queued report job and returns immediately (non-blocking)
 */
export const createReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userWorkspaceId = await getWorkspaceId(req);
    if (!userWorkspaceId) {
      res.status(403).json({ success: false, message: "Workspace not found or access denied" });
      return;
    }

    const parseResult = reportCreateSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        success: false,
        message: "Invalid report creation payload",
        error: parseResult.error.format(),
      });
      return;
    }

    const { format, formId, status, stageId, search, from, to, tagIds, assigneeId, unread, duplicate, ids, field, value, granularity } = parseResult.data;

    if (field !== undefined || value !== undefined) {
      const segForm = formId && mongoose.Types.ObjectId.isValid(formId) ? await Form.findOne({ _id: formId, workspaceId: userWorkspaceId }).select("fields").lean() : null;
      try {
        if (!segForm) throw new SegmentError(400, "FIELD_FILTER_REQUIRES_FORM", "field/value filtering needs a formId in this workspace");
        fieldSegmentFilter(segForm, field, value, granularity);
      } catch (e) {
        if (!(e instanceof SegmentError)) throw e;
        res.status(e.statusCode).json({ success: false, message: e.message, error: { code: e.code, message: e.message } });
        return;
      }
    }

    // PDF/CSV generation runs inside this process: refuse new jobs while this workspace already
    // has several in flight, and drop files of expired reports while we are here.
    const inFlight = await ReportModel.countDocuments({
      workspaceId: userWorkspaceId,
      status: { $in: ["queued", "processing"] },
      createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    if (inFlight >= 3) {
      res.status(429).json({
        success: false,
        message: "Too many reports are being generated. Wait for one to finish and try again.",
        error: { code: "REPORT_QUEUE_FULL", message: "Too many reports are being generated." },
      });
      return;
    }
    await purgeExpiredReportFiles(userWorkspaceId);

    // 24 hours expiration window
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const report = await ReportModel.create({
      workspaceId: new mongoose.Types.ObjectId(userWorkspaceId),
      requestedBy: (req as any).user?._id,
      format,
      filters: { formId, status, stageId, search, from, to, tagIds, assigneeId, unread, duplicate, ids, field, value, granularity },
      status: "queued",
      expiresAt,
    });

    // Resolve formTitle if formId provided
    let formTitle: string | null = "All Workspace Forms";
    if (formId && mongoose.Types.ObjectId.isValid(formId)) {
      // Scoped to the caller's workspace: another tenant's form title must never come back here.
      const formDoc = await Form.findOne({ _id: formId, workspaceId: userWorkspaceId }).select("title");
      if (formDoc) formTitle = formDoc.title;
    }

    // Kick off asynchronous background report generation
    kickReportQueue();

    const reportObj = {
      _id: report._id.toString(),
      id: report._id.toString(),
      workspaceId: report.workspaceId.toString(),
      format: report.format,
      status: report.status,
      formId: formId || null,
      formTitle: formTitle,
      filters: report.filters,
      errorMessage: null,
      fileSize: null,
      expiresAt: report.expiresAt,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };

    // Sprint 14 (B1.4): who / which form / how many rows / when. The count uses the same query the job will run.
    let rows: number | null = null;
    try {
      rows = await countReportRows(report);
      await ReportModel.updateOne({ _id: report._id }, { $set: { rowCount: rows } });
    } catch {
      // the audit row is still written, just without a count
    }
    await recordEvent(req, userWorkspaceId, "report.create", { id: report._id, type: "report", label: `${format} report` }, { reportId: report._id.toString(), format, formId: formId ?? null, rows });

    res.status(202).json({
      success: true,
      message: "Report job queued successfully",
      report: reportObj,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/reports?page=&limit=
 * Workspace-scoped report job listing (newest first)
 */
export const getReports = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userWorkspaceId = await getWorkspaceId(req);
    if (!userWorkspaceId) {
      res.status(200).json({
        success: true,
        reports: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const rawLimit = parseInt(req.query.limit as string, 10) || 10;
    const limit = Math.min(50, Math.max(1, rawLimit));
    const skip = (page - 1) * limit;

    const query = { workspaceId: new mongoose.Types.ObjectId(userWorkspaceId) };

    const total = await ReportModel.countDocuments(query);
    const reports = await ReportModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);

    // Map workspace forms for formTitle resolution
    const forms = await Form.find({ workspaceId: new mongoose.Types.ObjectId(userWorkspaceId) }).select("_id title");
    const formTitleMap = new Map(forms.map((f) => [f._id.toString(), f.title]));

    const now = new Date();
    const formattedReports = reports.map((r) => {
      let currentStatus = r.status;
      if (r.expiresAt && r.expiresAt < now && currentStatus === "completed") {
        currentStatus = "expired";
      }

      const formId = r.filters?.formId || null;
      const formTitle = formId ? formTitleMap.get(formId) || null : "All Workspace Forms";

      return {
        _id: r._id.toString(),
        id: r._id.toString(),
        workspaceId: r.workspaceId.toString(),
        format: r.format,
        status: currentStatus,
        formId,
        formTitle,
        filters: r.filters,
        errorMessage: r.errorMessage || null,
        fileSize: r.fileSize || null,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    res.status(200).json({
      success: true,
      data: formattedReports,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Shared by getReportById and getReportFile (Sprint 14, P5: the download path runs the same per-form
 * check as the read path). Sends the error response and returns null unless the caller may read the
 * report. Workspace-wide reports (no formId) rely on requirePermission: workspace membership + reports:read.
 * A report whose form is trashed/removed, or belongs to another workspace, is a 404.
 */
const loadReadableReport = async (req: Request, res: Response, workspaceId: string): Promise<any | null> => {
  const reportId = req.params.id as string;
  if (!mongoose.Types.ObjectId.isValid(reportId)) {
    res.status(400).json({ success: false, message: "Invalid report ID" });
    return null;
  }
  const report = await ReportModel.findById(reportId);
  if (!report) {
    res.status(404).json({ success: false, message: "Report not found" });
    return null;
  }
  if (report.workspaceId.toString() !== workspaceId) {
    res.status(403).json({ success: false, message: "Access denied to report from another workspace" });
    return null;
  }
  const formId = report.filters?.formId;
  if (formId) {
    // Form's default query hook hides trashed forms.
    const form = mongoose.Types.ObjectId.isValid(formId) ? await Form.findById(formId).select("workspaceId").lean() : null;
    if (!form || String(form.workspaceId ?? "") !== workspaceId) {
      res.status(404).json({ success: false, message: "Report not found" });
      return null;
    }
    const user = (req as any).user;
    if (user.role !== "super_admin" && !(await userHasAccessToForm(String(user._id), formId, workspaceId))) {
      res.status(403).json({ success: false, message: "You do not have access to this report's form" });
      return null;
    }
  }
  return report;
};

/**
 * GET /api/reports/:id
 * Workspace-scoped report detail
 */
export const getReportById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userWorkspaceId = await getWorkspaceId(req);
    if (!userWorkspaceId) {
      res.status(403).json({ success: false, message: "Workspace not found or access denied" });
      return;
    }

    const report = await loadReadableReport(req, res, userWorkspaceId);
    if (!report) return;

    const now = new Date();
    let currentStatus = report.status;
    if (report.expiresAt && report.expiresAt < now && currentStatus === "completed") {
      currentStatus = "expired";
    }

    const formId = report.filters?.formId || null;
    let formTitle: string | null = "All Workspace Forms";
    if (formId && mongoose.Types.ObjectId.isValid(formId)) {
      const formDoc = await Form.findOne({ _id: formId, workspaceId: userWorkspaceId }).select("title");
      if (formDoc) formTitle = formDoc.title;
    }

    res.status(200).json({
      success: true,
      report: {
        _id: report._id.toString(),
        id: report._id.toString(),
        workspaceId: report.workspaceId.toString(),
        format: report.format,
        status: currentStatus,
        formId,
        formTitle,
        filters: report.filters,
        errorMessage: report.errorMessage || null,
        fileSize: report.fileSize || null,
        expiresAt: report.expiresAt,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/reports/:id/file
 * Streams generated file (authenticated, path traversal guarded, 410 for expired)
 */
export const getReportFile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userWorkspaceId = await getWorkspaceId(req);
    if (!userWorkspaceId) {
      res.status(403).json({ success: false, message: "Workspace not found or access denied" });
      return;
    }

    const report = await loadReadableReport(req, res, userWorkspaceId);
    if (!report) return;

    const now = new Date();
    if (report.status === "expired" || (report.expiresAt && report.expiresAt < now)) {
      res.status(410).json({
        success: false,
        message: "Report download link has expired.",
      });
      return;
    }

    if (report.status !== "completed" || !report.filePath) {
      res.status(404).json({
        success: false,
        message: `Report is not ready yet (current status: ${report.status})`,
      });
      return;
    }

    // Path traversal guard
    const uploadsDir = path.resolve(process.cwd(), "uploads", "reports");
    const resolvedPath = path.resolve(report.filePath);
    if (!resolvedPath.startsWith(uploadsDir)) {
      res.status(403).json({ success: false, message: "Forbidden file path" });
      return;
    }

    if (!fs.existsSync(resolvedPath)) {
      res.status(404).json({ success: false, message: "Report file not found on disk" });
      return;
    }

    const contentType = report.format === "csv" ? "text/csv" : "application/pdf";
    const filename = `beginso_report_${report._id.toString()}.${report.format}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Sprint 14 (B1.4): record the download once the file has actually gone out; an aborted or failed
    // transfer never fires "finish", so it is never logged as a success.
    res.on("finish", () => {
      recordEvent(
        req,
        userWorkspaceId,
        "report.download",
        { id: report._id, type: "report", label: `${report.format} report` },
        { reportId: report._id.toString(), formId: report.filters?.formId ?? null, format: report.format, rows: report.rowCount ?? null }
      ).catch(() => undefined);
    });
    const readStream = fs.createReadStream(resolvedPath);
    readStream.on("error", (err) => {
      if (!res.headersSent) next(err);
      else res.destroy(err);
    });
    readStream.pipe(res);
  } catch (error) {
    next(error);
  }
};
