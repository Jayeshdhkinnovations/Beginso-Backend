import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import Workspace from "../models/Workspace";
import { assertVerifiedWorkspace } from "../utils/requestContext";
import { hashIp } from "../utils/ip";
import { recordEvent } from "../services/event.service";
import { StageService } from "../services/stage.service";
import {
  createStageSchema,
  updateStageSchema,
  deleteStageSchema,
  reorderStagesSchema,
} from "../validations/stage.validator";

const stageService = new StageService();

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

export const getStages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const stages = await stageService.listStages(workspace._id.toString());
    res.status(200).json({ success: true, stages, data: stages, total: stages.length });
  } catch (error: any) {
    if (error.statusCode) return sendError(res, error);
    next(error);
  }
};

export const createStage = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = createStageSchema.parse(req.body);
    const stage = await stageService.createStage(workspace._id.toString(), parsed);

    await recordEvent(req, workspace._id.toString(), "stage.create", { id: stage._id, type: "stage", label: stage.name });

    res.status(201).json({ success: true, message: "Stage created successfully", stage, data: stage });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const updateStage = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = updateStageSchema.parse(req.body);
    const { stageId } = req.params;
    const stage = await stageService.updateStage(workspace._id.toString(), String(stageId), parsed);

    await recordEvent(req, workspace._id.toString(), "stage.update", { id: stage._id, type: "stage", label: stage.name }, parsed);

    res.status(200).json({ success: true, message: "Stage updated successfully", stage, data: stage });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const deleteStage = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = deleteStageSchema.parse(req.body || {});
    const { stageId } = req.params;
    const authReq = req as any;
    const actor = authReq.user
      ? { id: authReq.user._id, email: authReq.user.email, name: authReq.user.fullName || authReq.user.email }
      : { id: null, email: "system", name: "system" };

    await stageService.deleteStage(workspace._id.toString(), String(stageId), {
      reassignTo: parsed.reassignTo,
      actor,
      ip: req.ip ? hashIp(req.ip) : undefined,
    });

    res.status(204).send();
  } catch (error: any) {
    sendError(res, error);
  }
};

export const reorderStages = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = reorderStagesSchema.parse(req.body);
    const stages = await stageService.reorderStages(workspace._id.toString(), parsed.orderedIds);

    res.status(200).json({ success: true, message: "Stages reordered successfully", stages, data: stages });
  } catch (error: any) {
    sendError(res, error);
  }
};
