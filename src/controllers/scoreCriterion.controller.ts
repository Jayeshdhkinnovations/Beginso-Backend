import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import Workspace from "../models/Workspace";
import { assertVerifiedWorkspace } from "../utils/requestContext";
import { ScoreService } from "../services/score.service";
import { IScoreCriterion } from "../models/ScoreCriterion";
import {
  createCriterionSchema,
  updateCriterionSchema,
  reorderCriteriaSchema,
} from "../validations/score.validator";

const scoreService = new ScoreService();

const toCriterionJson = (c: IScoreCriterion) => ({
  id: c._id.toString(),
  label: c.label,
  order: c.order,
  isDefault: c.isDefault,
});
const toCriteriaJson = (cs: IScoreCriterion[]) => cs.map(toCriterionJson);

const resolveWorkspace = async (paramId: any) => {
  if (!paramId) return null;
  const idStr = String(Array.isArray(paramId) ? paramId[0] : paramId).trim();
  if (mongoose.Types.ObjectId.isValid(idStr)) {
    const ws = await Workspace.findById(idStr);
    if (ws) return ws;
  }
  return await Workspace.findOne({ slug: idStr.toLowerCase() });
};

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

const getWorkspace = async (req: Request, res: Response) => {
  const rawParam = req.params.workspaceId || req.params.id;
  const workspace = await resolveWorkspace(rawParam);
  if (!workspace) {
    res.status(404).json({ success: false, message: "Workspace not found", error: { message: "Workspace not found" } });
    return null;
  }
  if (!assertVerifiedWorkspace(req, res, workspace._id)) return null;
  return workspace;
};

export const getScoreCriteria = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const criteria = await scoreService.listCriteria(workspace._id.toString());
    const json = toCriteriaJson(criteria);
    res.status(200).json({ success: true, criteria: json, data: json, total: json.length });
  } catch (error: any) {
    if (error.statusCode) return sendError(res, error);
    next(error);
  }
};

export const createScoreCriterion = async (req: Request, res: Response): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = createCriterionSchema.parse(req.body);
    const criterion = await scoreService.createCriterion(workspace._id.toString(), parsed);

    const json = toCriterionJson(criterion);
    res.status(201).json({ success: true, message: "Criterion created successfully", criterion: json, data: json });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const updateScoreCriterion = async (req: Request, res: Response): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = updateCriterionSchema.parse(req.body);
    const { criterionId } = req.params;
    const criterion = await scoreService.updateCriterion(workspace._id.toString(), String(criterionId), parsed);

    const json = toCriterionJson(criterion);
    res.status(200).json({ success: true, message: "Criterion updated successfully", criterion: json, data: json });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const deleteScoreCriterion = async (req: Request, res: Response): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const { criterionId } = req.params;
    await scoreService.deleteCriterion(workspace._id.toString(), String(criterionId));
    res.status(204).send();
  } catch (error: any) {
    sendError(res, error);
  }
};

export const reorderScoreCriteria = async (req: Request, res: Response): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = reorderCriteriaSchema.parse(req.body);
    const criteria = await scoreService.reorderCriteria(workspace._id.toString(), parsed.orderedIds);
    const json = toCriteriaJson(criteria);

    res.status(200).json({ success: true, message: "Criteria reordered successfully", criteria: json, data: json });
  } catch (error: any) {
    sendError(res, error);
  }
};
