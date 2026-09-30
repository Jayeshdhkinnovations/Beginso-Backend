import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { ScoreService } from "../services/score.service";
import { scoreResponseSchema } from "../validations/score.validator";
import ResponseModel from "../models/Response";
import Form from "../models/Form";

const scoreService = new ScoreService();

const sendError = (res: Response, error: any): void => {
  if (error instanceof ZodError) {
    res.status(422).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
      error: { message: "Validation failed" },
    });
    return;
  }
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: error.message || "Internal server error",
    error: { code: error.code, message: error.message || "Internal server error" },
  });
};

// PUT /api/responses/:id/score — upserts the caller's own row for {criterionId, value}.
// requirePermission("responses:write", { resourceType: "response" }) is the route-level gate
// (this repo's "act" tier, same as notes create/update); membershipId comes from that middleware.
export const scoreResponse = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }
    if (!authReq.membershipId) {
      // Personal-space / per-form-grant callers have no Membership row to key ScoreEntry on —
      // scoring is a workspace-membership concept (reviewerMembershipId), so it is refused rather
      // than silently keyed on something else.
      res.status(403).json({
        success: false,
        message: "Forbidden: scoring requires workspace membership",
        error: { code: "FORBIDDEN_NO_MEMBERSHIP", message: "Forbidden: scoring requires workspace membership" },
      });
      return;
    }

    const { id } = req.params;
    const parsed = scoreResponseSchema.parse(req.body);
    await scoreService.resolveResponseForm(String(id)); // 404s if the response doesn't exist

    await scoreService.upsertScore(String(id), String(authReq.membershipId), parsed.criterionId, parsed.value);

    const [aggregate, myRows] = await Promise.all([
      scoreService.aggregateFor(String(id)),
      scoreService.myRows(String(id), String(authReq.membershipId)),
    ]);

    res.status(200).json({
      success: true,
      message: "Score saved",
      data: { ...aggregate, myScores: myRows },
      ...aggregate,
      myScores: myRows,
    });
  } catch (error: any) {
    sendError(res, error);
  }
};

// GET /api/responses/:id/score — the caller's own per-criterion rows plus the response-level
// scoreAverage/scoreCount computed across every reviewer's rows.
export const getResponseScore = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const { id } = req.params;
    await scoreService.resolveResponseForm(String(id));

    const aggregate = await scoreService.aggregateFor(String(id));
    const myScores = authReq.membershipId
      ? await scoreService.myRows(String(id), String(authReq.membershipId))
      : [];

    res.status(200).json({ success: true, data: { ...aggregate, myScores }, ...aggregate, myScores });
  } catch (error: any) {
    if (error.statusCode) return sendError(res, error);
    next(error);
  }
};

// GET /api/forms/:formId/score-comparison?page&sort — rows across responses to this form,
// sortable by scoreAverage.
export const getScoreComparison = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { formId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(formId))) {
      res.status(404).json({ success: false, message: "Form not found", error: { message: "Form not found" } });
      return;
    }
    const form = await Form.findById(formId).select("_id").lean();
    if (!form) {
      res.status(404).json({ success: false, message: "Form not found", error: { message: "Form not found" } });
      return;
    }

    let page = Number(req.query.page) || 1;
    if (page < 1) page = 1;
    const limit = 20;
    const sort = req.query.sort === "asc" ? 1 : -1; // default desc, highest score first

    const responses = await ResponseModel.find({ formId, deletedAt: null })
      .select("_id reference submittedAt")
      .lean();
    const responseIds = responses.map((r: any) => r._id.toString());
    const aggregateMap = await scoreService.aggregateForMany(responseIds);

    const rows = responses.map((r: any) => {
      const agg = aggregateMap.get(r._id.toString()) || { scoreAverage: null, scoreCount: 0 };
      return {
        responseId: r._id.toString(),
        reference: r.reference,
        submittedAt: r.submittedAt,
        scoreAverage: agg.scoreAverage,
        scoreCount: agg.scoreCount,
      };
    });

    rows.sort((a, b) => {
      const av = a.scoreAverage ?? -1;
      const bv = b.scoreAverage ?? -1;
      return sort === 1 ? av - bv : bv - av;
    });

    const total = rows.length;
    const start = (page - 1) * limit;
    const paged = rows.slice(start, start + limit);

    res.status(200).json({
      success: true,
      data: paged,
      rows: paged,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error: any) {
    if (error.statusCode) return sendError(res, error);
    next(error);
  }
};
