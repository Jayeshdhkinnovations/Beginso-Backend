import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import ResponseModel from "../models/Response";
import {
  AnalyticsOverviewResponse,
  AnalyticsQuestionsResponse,
  AnalyticsTrendsResponse,
  AnalyticsFormsSummaryResponse,
} from "../types/analytics.types";

/**
 * Helper to resolve workspaceId from req.user
 */
const getWorkspaceId = async (req: Request): Promise<string | null> => {
  const authReq = req as any;
  if (!authReq.user) return null;

  let wsId = authReq.user.workspaceId;
  if (wsId && typeof wsId === "object" && wsId._id) {
    wsId = wsId._id.toString();
  } else if (wsId) {
    wsId = wsId.toString();
  }

  if (!wsId) {
    const workspace = await Workspace.findOne({ owner: authReq.user._id });
    if (workspace) {
      wsId = workspace._id.toString();
    }
  }

  return wsId ? wsId.toString() : null;
};

/**
 * Helper to validate form existence and workspace authorization.
 * Returns form document or sends error response (400, 404, 403).
 */
const validateFormAccess = async (
  req: Request,
  res: Response,
  formIdStr?: string
): Promise<{ form: any; userWorkspaceId: string } | null> => {
  const userWorkspaceId = await getWorkspaceId(req);
  if (!userWorkspaceId) {
    res.status(403).json({ success: false, message: "Workspace not found or access denied" });
    return null;
  }

  if (!formIdStr || !mongoose.Types.ObjectId.isValid(formIdStr)) {
    res.status(400).json({ success: false, message: "Valid formId query parameter is required" });
    return null;
  }

  const form = await Form.findById(formIdStr);
  if (!form) {
    res.status(404).json({ success: false, message: "Form not found" });
    return null;
  }

  const formWsId = form.workspaceId ? form.workspaceId.toString() : "";
  if (formWsId !== userWorkspaceId) {
    res.status(403).json({ success: false, message: "Access denied to form from another workspace" });
    return null;
  }

  return { form, userWorkspaceId };
};

/**
 * GET /api/analytics/overview?formId=&from=&to=&timezone=
 * Returns KPI totals (total, completed, in_progress, new), real completionRate, and statusDistribution using MongoDB $group
 */
export const getOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const formIdStr = req.query.formId as string;
    const access = await validateFormAccess(req, res, formIdStr);
    if (!access) return;

    const { form } = access;
    const fromStr = req.query.from as string;
    const toStr = req.query.to as string;
    const timezone = (req.query.timezone as string) || "UTC";

    const matchStage: any = { formId: form._id };
    let fromDate: Date | null = null;
    let toDate: Date | null = null;

    if (fromStr && fromStr !== "all") {
      fromDate = new Date(fromStr);
      if (!isNaN(fromDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$gte = fromDate;
      }
    }

    if (toStr && toStr !== "all") {
      toDate = new Date(toStr);
      if (!isNaN(toDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$lte = toDate;
      }
    }

    // Aggregate status counts in a single MongoDB $group pipeline
    const statusStats = await ResponseModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    let total = 0;
    let completed = 0;
    let in_progress = 0;
    let newCount = 0;

    for (const item of statusStats) {
      const cnt = item.count || 0;
      total += cnt;
      if (item._id === "completed") completed = cnt;
      else if (item._id === "in_progress") in_progress = cnt;
      else if (item._id === "new") newCount = cnt;
    }

    const completionRate = total > 0 ? Number(((completed / total) * 100).toFixed(2)) : 0;

    const statusDistribution = [
      {
        status: "completed" as const,
        count: completed,
        percentage: total > 0 ? Number(((completed / total) * 100).toFixed(2)) : 0,
      },
      {
        status: "in_progress" as const,
        count: in_progress,
        percentage: total > 0 ? Number(((in_progress / total) * 100).toFixed(2)) : 0,
      },
      {
        status: "new" as const,
        count: newCount,
        percentage: total > 0 ? Number(((newCount / total) * 100).toFixed(2)) : 0,
      },
    ];

    const responseData: AnalyticsOverviewResponse = {
      success: true,
      data: {
        formId: form._id.toString(),
        total,
        completed,
        in_progress,
        new: newCount,
        completionRate,
        statusDistribution,
        dateRange: {
          from: fromDate ? fromDate.toISOString() : null,
          to: toDate ? toDate.toISOString() : null,
          timezone,
        },
      },
    };

    res.status(200).json(responseData);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/questions?formId=&from=&to=&timezone=
 * Returns question option breakdowns with zero-count options included & soft-deleted fields excluded
 */
export const getQuestions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const formIdStr = req.query.formId as string;
    const access = await validateFormAccess(req, res, formIdStr);
    if (!access) return;

    const { form } = access;
    const fromStr = req.query.from as string;
    const toStr = req.query.to as string;
    const timezone = (req.query.timezone as string) || "UTC";

    const matchStage: any = { formId: form._id };
    let fromDate: Date | null = null;
    let toDate: Date | null = null;

    if (fromStr && fromStr !== "all") {
      fromDate = new Date(fromStr);
      if (!isNaN(fromDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$gte = fromDate;
      }
    }

    if (toStr && toStr !== "all") {
      toDate = new Date(toStr);
      if (!isNaN(toDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$lte = toDate;
      }
    }

    const responses = await ResponseModel.find(matchStage);
    const totalResponses = responses.length;

    // Filter out soft-deleted fields (deleted: true)
    const activeFields = (form.fields || []).filter((f: any) => !f.deleted);

    // Helper to resolve field answer value from response.answers under any keying scheme (fieldId, label, id, _id)
    const getFieldValue = (answers: Record<string, any> | undefined, field: any): any => {
      if (!answers || typeof answers !== "object") return undefined;
      if (field.fieldId && answers[field.fieldId] !== undefined) {
        return answers[field.fieldId];
      }
      if (field.label && answers[field.label] !== undefined) {
        return answers[field.label];
      }
      const altId = field.id || (field._id ? field._id.toString() : undefined);
      if (altId && answers[altId] !== undefined) {
        return answers[altId];
      }
      return undefined;
    };

    const questionsAnalytics = activeFields.map((field: any) => {
      const fieldId = field.fieldId || field.id || field._id?.toString();
      const label = field.label || "Untitled Field";
      const type = field.type || "short_text";

      let totalAnswered = 0;
      const optionCountMap = new Map<string, number>();
      const sampleAnswers: string[] = [];

      // Pre-populate defined options with zero count
      if (field.options && Array.isArray(field.options)) {
        for (const opt of field.options) {
          const optLabel = typeof opt === "string" ? opt : opt.label || opt.value || "";
          if (optLabel) {
            optionCountMap.set(optLabel, 0);
          }
        }
      }

      for (const r of responses) {
        const val = getFieldValue(r.answers, field);
        if (val !== undefined && val !== null && val !== "") {
          totalAnswered++;
          if (Array.isArray(val)) {
            // Checkbox multi-value answer handling
            for (const item of val) {
              const strVal = String(item).trim();
              if (strVal) {
                let matchedKey = strVal;
                for (const key of optionCountMap.keys()) {
                  if (key.toLowerCase() === strVal.toLowerCase()) {
                    matchedKey = key;
                    break;
                  }
                }
                optionCountMap.set(matchedKey, (optionCountMap.get(matchedKey) || 0) + 1);
              }
            }
          } else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
            const strVal = String(val).trim();
            if (strVal) {
              let matchedKey = strVal;
              for (const key of optionCountMap.keys()) {
                if (key.toLowerCase() === strVal.toLowerCase()) {
                  matchedKey = key;
                  break;
                }
              }
              optionCountMap.set(matchedKey, (optionCountMap.get(matchedKey) || 0) + 1);
              if (sampleAnswers.length < 5) {
                sampleAnswers.push(strVal);
              }
            }
          }
        }
      }

      const responseRate = totalResponses > 0 ? Number(((totalAnswered / totalResponses) * 100).toFixed(2)) : 0;

      const summary: any = {};
      if (["dropdown", "multiple_choice", "checkbox"].includes(type) || field.options?.length) {
        const definedOptions = field.options && Array.isArray(field.options) ? field.options : Array.from(optionCountMap.keys());
        const optionSummaries = definedOptions.map((opt: any) => {
          const optLabel = typeof opt === "string" ? opt : opt.label || opt.value || "";
          const cnt = optionCountMap.get(optLabel) || 0;
          const percentage = totalAnswered > 0 ? Number(((cnt / totalAnswered) * 100).toFixed(2)) : 0;
          return {
            label: optLabel,
            count: cnt,
            percentage,
          };
        });
        summary.options = optionSummaries;
      } else {
        summary.text = { sampleAnswers };
      }

      return {
        fieldId,
        label,
        type,
        totalAnswered,
        responseRate,
        summary,
      };
    });

    const responseData: AnalyticsQuestionsResponse = {
      success: true,
      data: {
        formId: form._id.toString(),
        totalResponses,
        questions: questionsAnalytics,
        dateRange: {
          from: fromDate ? fromDate.toISOString() : null,
          to: toDate ? toDate.toISOString() : null,
          timezone,
        },
      },
    };

    res.status(200).json(responseData);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/trends?formId=&from=&to=&bucket=day|week&timezone=
 * Returns { points: [{ bucketStart, responses }] } ordered ascending
 */
export const getTrends = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const formIdStr = req.query.formId as string;
    const access = await validateFormAccess(req, res, formIdStr);
    if (!access) return;

    const { form } = access;
    const fromStr = req.query.from as string;
    const toStr = req.query.to as string;
    const rawBucket = (req.query.bucket || req.query.interval || "day") as string;
    const bucket: "day" | "week" = rawBucket === "week" ? "week" : "day";
    const timezone = (req.query.timezone as string) || "UTC";

    const matchStage: any = { formId: form._id };
    let fromDate: Date | null = null;
    let toDate: Date | null = null;

    if (fromStr && fromStr !== "all") {
      fromDate = new Date(fromStr);
      if (!isNaN(fromDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$gte = fromDate;
      }
    }

    if (toStr && toStr !== "all") {
      toDate = new Date(toStr);
      if (!isNaN(toDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$lte = toDate;
      }
    }

    const dateFormat = bucket === "week" ? "%G-W%V" : "%Y-%m-%d";

    const trendGroup = await ResponseModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: "$submittedAt", timezone } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const points = trendGroup.map((item) => ({
      bucketStart: item._id || "unknown",
      responses: item.count || 0,
    }));

    const responseData: AnalyticsTrendsResponse = {
      success: true,
      points: points || [],
      dateRange: {
        from: fromDate ? fromDate.toISOString() : null,
        to: toDate ? toDate.toISOString() : null,
        timezone,
        bucket,
      },
    };

    res.status(200).json(responseData);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/forms?from=&to=&page=&limit=
 * Returns per-form summary rows (title, status, totalResponses, sparkline, completionRate), paginated with enforced limit cap
 */
export const getForms = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userWorkspaceId = await getWorkspaceId(req);
    if (!userWorkspaceId) {
      res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      });
      return;
    }

    const fromStr = req.query.from as string;
    const toStr = req.query.to as string;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const rawLimit = parseInt(req.query.limit as string, 10) || 10;
    const limit = Math.min(50, Math.max(1, rawLimit));
    const skip = (page - 1) * limit;

    const totalFormsCount = await Form.countDocuments({ workspaceId: userWorkspaceId });
    const forms = await Form.find({ workspaceId: userWorkspaceId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const formIds = forms.map((f) => f._id);

    const matchStage: any = { formId: { $in: formIds } };
    if (fromStr && fromStr !== "all") {
      const fromDate = new Date(fromStr);
      if (!isNaN(fromDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$gte = fromDate;
      }
    }
    if (toStr && toStr !== "all") {
      const toDate = new Date(toStr);
      if (!isNaN(toDate.getTime())) {
        matchStage.submittedAt = matchStage.submittedAt || {};
        matchStage.submittedAt.$lte = toDate;
      }
    }

    // Aggregate total and completed responses per form
    const statsGroup = await ResponseModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$formId",
          total: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
            },
          },
        },
      },
    ]);

    const statsMap = new Map(statsGroup.map((s) => [s._id.toString(), s]));

    // Aggregate sparkline points per form (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sparklineMatch = { ...matchStage };
    sparklineMatch.submittedAt = { $gte: sevenDaysAgo };

    const sparklineGroup = await ResponseModel.aggregate([
      { $match: sparklineMatch },
      {
        $group: {
          _id: {
            formId: "$formId",
            day: { $dateToString: { format: "%Y-%m-%d", date: "$submittedAt" } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]);

    const sparklineMap = new Map<string, number[]>();
    for (const sg of sparklineGroup) {
      const fId = sg._id.formId.toString();
      if (!sparklineMap.has(fId)) {
        sparklineMap.set(fId, []);
      }
      sparklineMap.get(fId)!.push(sg.count || 0);
    }

    const formsSummaryRows = forms.map((form) => {
      const fId = form._id.toString();
      const st = statsMap.get(fId) || { total: 0, completed: 0 };
      const completionRate = st.total > 0 ? Number(((st.completed / st.total) * 100).toFixed(2)) : 0;
      const sparkline = sparklineMap.get(fId) || [0, 0, 0, 0, 0, 0, 0];
      return {
        formId: fId,
        title: form.title,
        status: form.status,
        totalResponses: st.total,
        completionRate,
        sparkline,
        updatedAt: form.updatedAt,
      };
    });

    const responseData: AnalyticsFormsSummaryResponse = {
      success: true,
      data: formsSummaryRows,
      total: totalFormsCount,
      page,
      limit,
      totalPages: Math.ceil(totalFormsCount / limit) || 1,
    };

    res.status(200).json(responseData);
  } catch (error) {
    next(error);
  }
};
