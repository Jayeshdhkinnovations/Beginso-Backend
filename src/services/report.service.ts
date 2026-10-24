import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import ReportModel from "../models/Report";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { buildResponseFilterQuery } from "../utils/responseFilters";
import { reportFormsFilter } from "../utils/formAccess";
import { ScoreService } from "./score.service";
import Stage from "../models/Stage";
import { buildAnswerKeyMap } from "../utils/answerKeys";
import { drawResponsesPdf, drawPdfFooter, type PdfForm, type PdfResponse } from "../utils/responsePdf";
import { csvCell, buildQuestionColumns, rowCells, statusLabel, niceAxis, createQuestionTally, OTHER_COLUMN, type ExportField } from "../utils/reportExport";

const scoreService = new ScoreService();

// The most responses one PDF of chosen responses holds (a PDF of thousands of pages is not what anyone reads; the CSV has no limit).
const MAX_RESPONSE_PDF = 200;

const UPLOADS_REPORTS_DIR = path.join(process.cwd(), "uploads", "reports");

const ensureReportsDir = (): void => {
  if (!fs.existsSync(UPLOADS_REPORTS_DIR)) {
    fs.mkdirSync(UPLOADS_REPORTS_DIR, { recursive: true });
  }
};

/**
 * Draws one filled annulus sector (a donut "slice") between startDeg/endDeg,
 * where 0deg = 12 o'clock, increasing clockwise.
 */
const drawDonutSlice = (
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startDeg: number,
  endDeg: number,
  color: string
): void => {
  if (endDeg <= startDeg) return;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const point = (r: number, deg: number) => ({
    x: cx + r * Math.sin(toRad(deg)),
    y: cy - r * Math.cos(toRad(deg)),
  });

  // 4deg-per-segment resolution is smooth enough at report print size while staying cheap.
  const steps = Math.max(1, Math.ceil((endDeg - startDeg) / 4));
  const outerPts = Array.from({ length: steps + 1 }, (_, i) =>
    point(outerR, startDeg + ((endDeg - startDeg) * i) / steps)
  );
  const innerPts = Array.from({ length: steps + 1 }, (_, i) =>
    point(innerR, endDeg - ((endDeg - startDeg) * i) / steps)
  );

  doc.moveTo(outerPts[0].x, outerPts[0].y);
  outerPts.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
  innerPts.forEach((p) => doc.lineTo(p.x, p.y));
  doc.closePath().fill(color);
};

type TrendBucket = { label: string; count: number };

/**
 * Builds zero-filled trend buckets spanning [start, end] from a day->count map, so gaps in
 * activity render as real dips instead of being silently skipped. Daily buckets for ranges up
 * to 45 days, weekly beyond that, to keep the x-axis legible (mirrors the frontend's automatic
 * day/week bucket choice — see design.md's Response Trend chart).
 */
const buildTrendBuckets = (start: Date, end: Date, countsByDay: Map<string, number>): TrendBucket[] => {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / oneDayMs));
  const bucketDays = spanDays > 45 ? 7 : 1;

  const buckets: TrendBucket[] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + bucketDays * oneDayMs)) {
    const bucketEnd = new Date(Math.min(d.getTime() + (bucketDays - 1) * oneDayMs, end.getTime()));
    let count = 0;
    for (let x = new Date(d); x <= bucketEnd; x = new Date(x.getTime() + oneDayMs)) {
      count += countsByDay.get(x.toISOString().slice(0, 10)) || 0;
    }
    buckets.push({
      label: d.toLocaleDateString("en-US", { day: "numeric", month: "short" }),
      count,
    });
  }
  return buckets;
};

/**
 * The response query a report exports. Shared by generation and by the row count recorded on `report.create`
 * (Sprint 14, B1.4), so the number in the audit trail is the number of rows the file will hold.
 */
export const buildReportQuery = async (report: any, workspaceFormIds: any[]): Promise<any> => {
  const filters: any = report.filters || {};
    // Sprint 12, BE 0.2 (B2.11): the export IS the list — same filter shape, same permission
    // scoping (workspace forms only), same deletedAt exclusion — built via the one shared helper
    // the bulk endpoint's filter target also uses, so the two never drift apart. `ids` bypasses
    // the filter entirely in favour of an explicit id list (still scoped to workspace forms below).
    let query: any;
    if (filters.ids && filters.ids.length > 0) {
      const validIds = filters.ids.filter((id: string) => mongoose.Types.ObjectId.isValid(id));
      query = { _id: { $in: validIds }, formId: { $in: workspaceFormIds }, deletedAt: null };
    } else {
      query = await buildResponseFilterQuery(
        {
          formId: filters.formId,
          stageId: filters.stageId,
          tagIds: filters.tagIds,
          assigneeId: filters.assigneeId,
          unread: filters.unread,
          from: filters.from && filters.from !== "all" ? filters.from : undefined,
          to: filters.to && filters.to !== "all" ? filters.to : undefined,
          q: filters.search,
          field: filters.field,
          value: filters.value,
          granularity: filters.granularity,
        },
        workspaceFormIds,
        report.requestedBy ? report.requestedBy.toString() : undefined
      );
      // Legacy single-status filter, still honoured alongside the new filter shape.
      if (filters.status && ["new", "in_progress", "completed"].includes(filters.status)) {
        query.status = filters.status;
      }
    }
  return query;
};

export const countReportRows = async (report: any): Promise<number> => {
  const forms = await Form.find(await reportFormsFilter(report.workspaceId, report.requestedBy)).select("_id");
  const query = await buildReportQuery(report, forms.map((f) => f._id));
  return ResponseModel.countDocuments(query);
};

/**
 * Background Asynchronous Generator for CSV and PDF Reports.
 */
export const generateReportAsync = async (reportId: string): Promise<void> => {
  try {
    ensureReportsDir();

    const report = await ReportModel.findById(reportId);
    if (!report || report.status === "completed" || report.status === "failed") {
      return;
    }

    report.status = "processing";
    await report.save();

    // Resolve workspace forms
    const forms = await Form.find(await reportFormsFilter(report.workspaceId, report.requestedBy));
    const formMap = new Map(forms.map((f) => [f._id.toString(), f]));
    const workspaceFormIds = forms.map((f) => f._id);

    const filters = report.filters || {};
    const query = await buildReportQuery(report, workspaceFormIds);

    // Kept for the PDF's trend-chart range below.
    const fromDateObj: Date | null =
      filters.from && filters.from !== "all" && !isNaN(new Date(filters.from).getTime())
        ? new Date(filters.from)
        : null;
    const toDateObj: Date | null =
      filters.to && filters.to !== "all" && !isNaN(new Date(filters.to).getTime()) ? new Date(filters.to) : null;

    const filename = `${report._id.toString()}.${report.format}`;
    const targetFilePath = path.join(UPLOADS_REPORTS_DIR, filename);

    if (report.format === "csv") {
      const writeStream = fs.createWriteStream(targetFilePath, { encoding: "utf8" });

      // One column per question (header = the question's label) after the fixed metadata columns.
      // "Reference" is the per-form sequential id (e.g. "#142"); notes never belong in this export.
      // "Score Average"/"Score Count" mirror the response read path (pooled mean, distinct reviewers).
      const exportForms = (filters.formId ? forms.filter((f) => f._id.toString() === filters.formId) : forms).map((f) => {
        const raw = (f.fields as any[]) ?? [];
        const keys = buildAnswerKeyMap(raw);
        return {
          id: f._id.toString(),
          fields: raw.map((x) => ({ fieldId: x.fieldId, _id: x._id, label: x.label, type: x.type, answerKey: keys.get(x) }) as ExportField),
        };
      });
      const { columns, byForm } = buildQuestionColumns(exportForms);
      const fieldsByForm = new Map(exportForms.map((f) => [f.id, f.fields]));
      const meta = ["Response ID", "Reference", "Form ID", "Form Title", "Status", "Submitted At", "Score Average", "Score Count"];
      // UTF-8 BOM so Excel reads accented / non-Latin text correctly.
      writeStream.write("﻿" + [...meta, ...columns, OTHER_COLUMN].map(csvCell).join(",") + "\n");

      const stageNames = new Map<string, string>();
      const loadStageNames = async (rows: any[]) => {
        const missing = [...new Set(rows.map((r) => r.stageId?.toString()).filter((id) => id && !stageNames.has(id)))];
        if (missing.length === 0) return;
        const found = await Stage.find({ _id: { $in: missing } }).select("name").lean();
        missing.forEach((id) => stageNames.set(id as string, ""));
        found.forEach((st: any) => stageNames.set(st._id.toString(), st.name));
      };

      const SCORE_BATCH_SIZE = 200;
      let batch: any[] = [];
      const flushBatch = async () => {
        if (batch.length === 0) return;
        const scoreMap = await scoreService.aggregateForMany(batch.map((r) => r._id.toString()));
        await loadStageNames(batch);
        for (const r of batch) {
          const formId = r.formId.toString();
          const formTitle = formMap.get(formId)?.title || "Form Response";
          const { cells, other } = rowCells(
            (r.answers as Record<string, unknown>) ?? {},
            fieldsByForm.get(formId) ?? [],
            byForm.get(formId) ?? [],
            columns
          );
          const agg = scoreMap.get(r._id.toString()) || { scoreAverage: null, scoreCount: 0 };
          const row = [
            r._id.toString(),
            r.reference || "",
            formId,
            formTitle,
            statusLabel(r.status, r.stageId ? stageNames.get(r.stageId.toString()) : null),
            (r.submittedAt ?? r.createdAt).toISOString(),
            agg.scoreAverage !== null ? agg.scoreAverage.toFixed(2) : "",
            agg.scoreCount,
            ...cells,
            other,
          ];
          writeStream.write(row.map(csvCell).join(",") + "\n");
        }
        batch = [];
      };

      const cursor = ResponseModel.find(query).sort({ submittedAt: -1 }).cursor();
      for (let r = await cursor.next(); r != null; r = await cursor.next()) {
        batch.push(r);
        if (batch.length >= SCORE_BATCH_SIZE) await flushBatch();
      }
      await flushBatch();

      await new Promise<void>((resolve, reject) => {
        writeStream.end();
        writeStream.on("finish", () => resolve());
        writeStream.on("error", (err) => reject(err));
      });
    } else if (report.format === "pdf" && filters.ids && filters.ids.length > 0) {
      // Chosen responses: the PDF is the responses themselves (every question with its answer), not the analytics report.
      const rows = await ResponseModel.find(query).sort({ submittedAt: -1 }).limit(MAX_RESPONSE_PDF).lean();
      const scoreMap = await scoreService.aggregateForMany(rows.map((r: any) => r._id.toString()));
      const stageIds = [...new Set(rows.map((r: any) => r.stageId?.toString()).filter(Boolean))];
      const stages = stageIds.length > 0 ? await Stage.find({ _id: { $in: stageIds } }).select("name").lean() : [];
      const stageNames = new Map(stages.map((st: any) => [st._id.toString(), st.name as string]));
      const pdfForms = new Map<string, PdfForm>();
      for (const f of forms) {
        pdfForms.set(f._id.toString(), {
          title: f.title,
          fields: ((f.fields as any[]) ?? []).map((x) => ({ fieldId: x.fieldId, _id: x._id, label: x.label, type: x.type, pageId: x.pageId, deleted: x.deleted, order: x.order })),
          pages: ((f.pages as any[]) ?? []).map((pg) => ({ id: pg.id, order: pg.order, title: pg.title })),
        });
      }
      const pdfRows: PdfResponse[] = rows.map((r: any) => {
        const agg = scoreMap.get(r._id.toString());
        return {
          id: r._id.toString(),
          formId: r.formId.toString(),
          reference: r.reference,
          status: r.status,
          stageName: r.stageId ? stageNames.get(r.stageId.toString()) : null,
          email: r.respondentEmail,
          submittedAt: r.submittedAt ?? r.createdAt,
          answers: r.answers instanceof Map ? Object.fromEntries(r.answers) : (r.answers ?? {}),
          scoreAverage: agg?.scoreAverage ?? null,
          scoreCount: agg?.scoreCount ?? 0,
        };
      });
      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true, info: { Title: "Beginso responses" } });
        const writeStream = fs.createWriteStream(targetFilePath);
        writeStream.on("finish", () => resolve());
        writeStream.on("error", (err) => reject(err));
        doc.on("error", (err) => reject(err));
        doc.pipe(writeStream);
        if (pdfRows.length === 0) {
          doc.fillColor("#64748B").fontSize(11).font("Helvetica").text("None of the selected responses could be found.", 40, 40);
        } else {
          drawResponsesPdf(doc, pdfRows, pdfForms);
        }
        drawPdfFooter(doc, pdfRows.length === 1 ? `Beginso · ${pdfForms.get(pdfRows[0].formId)?.title ?? "Response"}` : `Beginso · ${pdfRows.length} responses`);
        doc.end();
      });
    } else if (report.format === "pdf") {
      // PDF generation matching the live Analytics Dashboard layout (KPI cards, Trend line
      // chart, Status donut, Appendix). Stats/trend are computed via aggregation against the
      // FULL matching set — not the capped appendix listing below — so KPI totals and the trend
      // chart stay accurate even when a report matches more responses than the appendix shows.
      const APPENDIX_LIMIT = 500;

      const statusAgg = await ResponseModel.aggregate([
        { $match: query },
        { $group: { _id: { $ifNull: ["$status", "new"] }, count: { $sum: 1 } } },
      ]);
      const countsByStatus = new Map<string, number>(statusAgg.map((d: any) => [d._id, d.count]));
      const completedCount = countsByStatus.get("completed") || 0;
      const inProgressCount = countsByStatus.get("in_progress") || 0;
      const newCount = countsByStatus.get("new") || 0;
      const totalCount = completedCount + inProgressCount + newCount;

      const trendAgg = await ResponseModel.aggregate([
        { $match: query },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: { $ifNull: ["$submittedAt", "$createdAt"] } } },
            count: { $sum: 1 },
          },
        },
      ]);
      const countsByDay = new Map<string, number>(trendAgg.map((d: any) => [d._id, d.count]));
      const dayKeys = Array.from(countsByDay.keys()).sort();
      const rangeStart = fromDateObj ?? (dayKeys.length > 0 ? new Date(dayKeys[0]) : new Date(Date.now() - 29 * 86400000));
      const rangeEnd = toDateObj ?? new Date();
      const trendBuckets = buildTrendBuckets(rangeStart, rangeEnd, countsByDay);

      // Per-question tallies over every matching response (streamed), only meaningful for one form.
      let questionSummary: ReturnType<ReturnType<typeof createQuestionTally>["summary"]> | null = null;
      if (filters.formId && formMap.has(filters.formId)) {
        const rawFields = (formMap.get(filters.formId)!.fields as any[]) ?? [];
        const qKeys = buildAnswerKeyMap(rawFields);
        const qFields = rawFields.map((x) => ({ fieldId: x.fieldId, _id: x._id, label: x.label, type: x.type, answerKey: qKeys.get(x) }) as ExportField);
        const tally = createQuestionTally(qFields);
        const qCursor = ResponseModel.find(query).select("answers").lean().cursor();
        for (let r = await qCursor.next(); r != null; r = await qCursor.next()) tally.add((r as any).answers ?? {});
        questionSummary = tally.summary();
      }

      const listResponses = await ResponseModel.find(query).sort({ submittedAt: -1 }).limit(APPENDIX_LIMIT);

      // Determine scoped form title
      let scopedTitle = "All Workspace Forms";
      if (filters.formId && formMap.has(filters.formId)) {
        scopedTitle = formMap.get(filters.formId)!.title;
      }

      // Format date range text — handles a one-sided range (from only / to only) instead of
      // silently falling back to "All Time" whenever either side was left unset.
      const rangeText =
        fromDateObj || toDateObj
          ? `${fromDateObj ? fromDateObj.toISOString().slice(0, 10) : "Start"} to ${toDateObj ? toDateObj.toISOString().slice(0, 10) : "Now"
          }`
          : "All Time";

      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
        const writeStream = fs.createWriteStream(targetFilePath);

        writeStream.on("finish", () => resolve());
        writeStream.on("error", (err) => reject(err));
        doc.on("error", (err) => reject(err));

        doc.pipe(writeStream);

        // --- 1. HEADER SECTION ---
        doc.fillColor("#1D4ED8").fontSize(20).font("Helvetica-Bold").text("BEGINSO", 40, 40);
        doc.fillColor("#0F172A").fontSize(16).font("Helvetica-Bold").text("Analytics Report", 40, 68);
        doc.fillColor("#475569").fontSize(11).font("Helvetica").text(`Form: ${scopedTitle}`, 40, 90);

        doc.fillColor("#64748B").fontSize(9).font("Helvetica");
        doc.text(`Report Period: ${rangeText}`, 350, 40, { align: "right" });
        doc.text(`Generated: ${new Date().toUTCString()}`, 350, 54, { align: "right" });

        // Divider
        doc.moveTo(40, 112).lineTo(555, 112).strokeColor("#E2E8F0").lineWidth(1).stroke();

        // --- 2. SUMMARY ROW (4 EQUAL-WIDTH KPI CARDS) ---
        const startY = 125;
        const cardWidth = 120;
        const cardHeight = 55;
        const gap = 12;

        const kpis = [
          { label: "TOTAL RESPONSES", count: totalCount, color: "#0F172A" },
          { label: "COMPLETED", count: completedCount, color: "#22C55E" },
          { label: "IN PROGRESS", count: inProgressCount, color: "#EAB308" },
          { label: "NEW", count: newCount, color: "#3B82F6" },
        ];

        kpis.forEach((kpi, idx) => {
          const x = 40 + idx * (cardWidth + gap);
          doc.roundedRect(x, startY, cardWidth, cardHeight, 6).fillAndStroke("#F8FAFC", "#E2E8F0");
          doc.fillColor("#64748B").fontSize(7).font("Helvetica-Bold").text(kpi.label, x + 10, startY + 10);
          doc.fillColor(kpi.color).fontSize(18).font("Helvetica-Bold").text(String(kpi.count), x + 10, startY + 24);
        });

        // --- 3. STATUS DISTRIBUTION DONUT CHART ---
        let currentY = 195;
        doc.fillColor("#0F172A").fontSize(12).font("Helvetica-Bold").text("Status Distribution", 40, currentY);
        currentY += 20;

        const donutCx = 130;
        const donutCy = currentY + 80;
        const donutOuterR = 70;
        const donutInnerR = 42;

        const statusSlices = [
          { label: "New", count: newCount, color: "#3B82F6" },
          { label: "In Progress", count: inProgressCount, color: "#EAB308" },
          { label: "Completed", count: completedCount, color: "#22C55E" },
        ];
        // Same one-decimal-place percentage formula the live Analytics dashboard uses
        // (StatusDistributionChart's `percentOf`) — kept identical so the PDF and the in-app
        // chart never disagree on the displayed number.
        const pctOf = (count: number) => (totalCount > 0 ? ((count / totalCount) * 100).toFixed(1) : "0.0");

        if (totalCount === 0) {
          drawDonutSlice(doc, donutCx, donutCy, donutOuterR, donutInnerR, 0, 360, "#E2E8F0");
        } else {
          let angleCursor = 0;
          statusSlices.forEach((s) => {
            const sweep = (s.count / totalCount) * 360;
            if (sweep > 0) {
              drawDonutSlice(doc, donutCx, donutCy, donutOuterR, donutInnerR, angleCursor, angleCursor + sweep, s.color);
            }
            angleCursor += sweep;
          });
        }

        doc
          .fillColor("#0F172A")
          .fontSize(20)
          .font("Helvetica-Bold")
          .text(String(totalCount), donutCx - donutInnerR, donutCy - 14, { width: donutInnerR * 2, align: "center" });
        doc
          .fillColor("#64748B")
          .fontSize(8)
          .font("Helvetica")
          .text("Responses", donutCx - donutInnerR, donutCy + 10, { width: donutInnerR * 2, align: "center" });

        const legendX = 230;
        let legendY = donutCy - donutOuterR + 6;
        statusSlices.forEach((s) => {
          doc.circle(legendX + 4, legendY + 4, 4).fill(s.color);
          doc
            .fillColor("#334155")
            .fontSize(9)
            .font("Helvetica-Bold")
            .text(`${s.label} — ${s.count} · ${pctOf(s.count)}%`, legendX + 16, legendY);
          legendY += 20;
        });

        currentY = donutCy + donutOuterR + 20;

        // --- 4. RESPONSE TREND LINE CHART ---
        doc.fillColor("#0F172A").fontSize(12).font("Helvetica-Bold").text("Response Trend", 40, currentY);
        currentY += 18;

        const chartX = 40;
        const chartY = currentY;
        const chartW = 515;
        const chartH = 110;
        const chartPadLeft = 24;
        const chartPadBottom = 16;

        doc.roundedRect(chartX, chartY, chartW, chartH, 6).fillAndStroke("#FFFFFF", "#E2E8F0");

        const plotX = chartX + chartPadLeft;
        const plotW = chartW - chartPadLeft - 10;
        const plotY = chartY + 8;
        const plotH = chartH - chartPadBottom - 16;

        const axis = niceAxis(Math.max(1, ...trendBuckets.map((b) => b.count)));
        const maxCount = axis.max;
        for (const val of axis.ticks) {
          const y = plotY + plotH - (val / maxCount) * plotH;
          doc.moveTo(plotX, y).lineTo(plotX + plotW, y).strokeColor("#F1F5F9").lineWidth(0.5).stroke();
          doc
            .fillColor("#94A3B8")
            .fontSize(6)
            .font("Helvetica")
            .text(String(val), chartX + 2, y - 3, { width: chartPadLeft - 4, align: "right" });
        }

        if (trendBuckets.length > 0) {
          const stepX = trendBuckets.length > 1 ? plotW / (trendBuckets.length - 1) : 0;
          const points = trendBuckets.map((b, i) => ({
            x: plotX + stepX * i,
            y: plotY + plotH - (b.count / maxCount) * plotH,
            label: b.label,
          }));

          doc.moveTo(points[0].x, points[0].y);
          points.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
          doc.strokeColor("#1D4ED8").lineWidth(1.5).stroke();

          points.forEach((p) => doc.circle(p.x, p.y, 1.6).fill("#1D4ED8"));

          // Thin out x-axis labels once there are more buckets than fit legibly.
          const maxLabels = 10;
          const labelStride = Math.max(1, Math.ceil(points.length / maxLabels));
          points.forEach((p, i) => {
            if (i % labelStride !== 0 && i !== points.length - 1) return;
            doc
              .fillColor("#64748B")
              .fontSize(6)
              .font("Helvetica")
              .text(p.label, p.x - 14, plotY + plotH + 4, { width: 28, align: "center" });
          });
        }

        currentY = chartY + chartH + 18;

        // --- 4b. PER-QUESTION BREAKDOWN (single-form reports; computed over the full matching set) ---
        // All-forms reports skip this section (a breakdown only makes sense for one form's questions).
        if (questionSummary) {
          doc.fillColor("#0F172A").fontSize(12).font("Helvetica-Bold").text("Question Breakdown", 40, currentY);
          currentY += 16;
          for (const q of questionSummary) {
            const rows = q.counts ? q.counts.slice(0, 8) : [];
            if (currentY + 22 + rows.length * 11 > 760) {
              doc.addPage();
              currentY = 40;
            }
            doc.fillColor("#334155").fontSize(9).font("Helvetica-Bold").text(q.label, 40, currentY, { width: 515, lineBreak: false, ellipsis: true });
            doc.fillColor("#94A3B8").fontSize(8).font("Helvetica").text(`${q.answered} of ${totalCount} answered`, 40, currentY + 11);
            currentY += 24;
            for (const c of rows) {
              const pct = q.answered > 0 ? Math.round((c.count / q.answered) * 100) : 0;
              doc.fillColor("#475569").fontSize(8).font("Helvetica").text(c.value, 52, currentY, { width: 330, lineBreak: false, ellipsis: true });
              doc.text(`${c.count} (${pct}%)`, 400, currentY, { width: 100, align: "right", lineBreak: false });
              currentY += 11;
            }
            currentY += 6;
          }
          currentY += 8;
        }

        // --- 5. RESPONSE RECORDS APPENDIX TABLE ---
        doc.fillColor("#0F172A").fontSize(12).font("Helvetica-Bold").text("Response Records Appendix", 40, currentY);
        currentY += 14;
        if (totalCount > APPENDIX_LIMIT) {
          doc
            .fillColor("#94A3B8")
            .fontSize(8)
            .font("Helvetica")
            .text(`Showing the most recent ${APPENDIX_LIMIT} of ${totalCount} matching responses.`, 40, currentY);
          currentY += 12;
        }
        currentY += 4;

        // Table Header
        const tX = 40;
        const colWidths = [160, 160, 90, 105];

        const drawTableHeader = (y: number): void => {
          doc.rect(tX, y, 515, 18).fill("#1E40AF");
          doc.fillColor("#FFFFFF").fontSize(8).font("Helvetica-Bold");
          doc.text("RESPONSE ID", tX + 8, y + 5);
          doc.text("FORM TITLE", tX + 8 + colWidths[0], y + 5);
          doc.text("STATUS", tX + 8 + colWidths[0] + colWidths[1], y + 5);
          doc.text("SUBMITTED AT", tX + 8 + colWidths[0] + colWidths[1] + colWidths[2], y + 5);
        };

        drawTableHeader(currentY);
        currentY += 18;

        if (listResponses.length === 0) {
          doc.fillColor("#64748B").fontSize(9).font("Helvetica").text("No response records match the criteria.", tX + 8, currentY + 8);
        } else {
          listResponses.forEach((r, idx) => {
            if (currentY > 740) {
              doc.addPage();
              currentY = 40;
              drawTableHeader(currentY);
              currentY += 18;
            }

            const bg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
            doc.rect(tX, currentY, 515, 16).fill(bg);

            const formTitle = formMap.get(r.formId.toString())?.title || scopedTitle;
            const dateStr = (r.submittedAt || r.createdAt).toISOString().slice(0, 10);
            const statusStr = r.status || "new";
            const statusColor = statusStr === "completed" ? "#15803D" : statusStr === "in_progress" ? "#A16207" : "#1D4ED8";

            doc.fillColor("#334155").fontSize(8).font("Helvetica");
            doc.text(r._id.toString(), tX + 8, currentY + 4, { width: colWidths[0] - 10 });
            doc.text(formTitle, tX + 8 + colWidths[0], currentY + 4, { width: colWidths[1] - 10 });
            doc.fillColor(statusColor).font("Helvetica-Bold").text(statusStr.toUpperCase(), tX + 8 + colWidths[0] + colWidths[1], currentY + 4);
            doc.fillColor("#334155").font("Helvetica").text(dateStr, tX + 8 + colWidths[0] + colWidths[1] + colWidths[2], currentY + 4);

            currentY += 16;
          });
        }

        // --- 6. FOOTER ON EVERY PAGE ---
        const rangePages = doc.bufferedPageRange();
        const footerY = 800;
        for (let i = rangePages.start; i < rangePages.start + rangePages.count; i++) {
          doc.switchToPage(i);
          const pageNum = i + 1;
          const totalPages = rangePages.count;

          // The footer sits inside the page's bottom margin on purpose (y=800 on an A4 page with
          // margin:40 is past the ~802 usable content boundary). PDFKit's .text() silently auto-adds
          // a new page whenever it's asked to write below that boundary — even for absolutely-positioned
          // text — so without this, each of the three text() calls below spawned its own extra
          // near-blank page. Zeroing the bottom margin just for this page while drawing the footer
          // disables that check; restored right after.
          const originalBottomMargin = doc.page.margins.bottom;
          doc.page.margins.bottom = 0;

          doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor("#E2E8F0").lineWidth(0.5).stroke();
          doc.fillColor("#94A3B8").fontSize(8).font("Helvetica");
          doc.text("Beginso · Analytics Report", 40, footerY + 8, { lineBreak: false });
          doc.text(scopedTitle, 200, footerY + 8, { width: 195, align: "center", lineBreak: false });
          doc.text(`Page ${pageNum} of ${totalPages}`, 400, footerY + 8, { width: 115, align: "right", lineBreak: false });

          doc.page.margins.bottom = originalBottomMargin;
        }

        doc.end();
      });
    }

    if (!fs.existsSync(targetFilePath)) {
      throw new Error(`Report file failed to generate at path ${targetFilePath}`);
    }

    const stats = fs.statSync(targetFilePath);
    report.filePath = targetFilePath;
    report.fileSize = stats.size;
    report.status = "completed";
    report.errorMessage = undefined;
    await report.save();
  } catch (err: any) {
    console.error("Report generation error:", err);
    try {
      const report = await ReportModel.findById(reportId);
      if (report) {
        report.status = "failed";
        report.errorMessage = err?.message || "Failed to generate report due to an internal processing error. Please try again.";
        await report.save();
      }
    } catch {
      // Ignored
    }
  }
};