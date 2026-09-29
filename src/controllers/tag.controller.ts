import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import Workspace from "../models/Workspace";
import { assertVerifiedWorkspace } from "../utils/requestContext";
import { recordEvent } from "../services/event.service";
import { TagService } from "../services/tag.service";
import { createTagSchema, updateTagSchema, mergeTagSchema } from "../validations/tag.validator";

const tagService = new TagService();

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

export const getTags = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const tags = await tagService.listTags(workspace._id.toString());
    res.status(200).json({ success: true, tags, data: tags, total: tags.length });
  } catch (error: any) {
    if (error.statusCode) return sendError(res, error);
    next(error);
  }
};

export const createTag = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = createTagSchema.parse(req.body);
    const tag = await tagService.createTag(workspace._id.toString(), parsed);

    await recordEvent(req, workspace._id.toString(), "tag.create", { id: tag._id, type: "tag", label: tag.name });

    res.status(201).json({ success: true, message: "Tag created successfully", tag, data: tag });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const updateTag = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = updateTagSchema.parse(req.body);
    const { tagId } = req.params;
    const tag = await tagService.updateTag(workspace._id.toString(), String(tagId), parsed);

    await recordEvent(req, workspace._id.toString(), "tag.update", { id: tag._id, type: "tag", label: tag.name }, parsed);

    res.status(200).json({ success: true, message: "Tag updated successfully", tag, data: tag });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const deleteTag = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const { tagId } = req.params;
    const { usageCount } = await tagService.deleteTag(workspace._id.toString(), String(tagId));

    await recordEvent(req, workspace._id.toString(), "tag.delete", { id: String(tagId), type: "tag", label: String(tagId) }, { usageCount });

    res.status(200).json({ success: true, message: "Tag deleted successfully", usageCount });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const mergeTag = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const workspace = await getWorkspace(req, res);
    if (!workspace) return;

    const parsed = mergeTagSchema.parse(req.body);
    const { tagId } = req.params;
    const { mergedCount, into } = await tagService.mergeTag(workspace._id.toString(), String(tagId), parsed.into);

    await recordEvent(
      req,
      workspace._id.toString(),
      "tag.merge",
      { id: String(tagId), type: "tag", label: String(tagId) },
      { into: parsed.into, mergedCount }
    );

    res.status(200).json({ success: true, message: "Tags merged successfully", mergedCount, tag: into, data: into });
  } catch (error: any) {
    sendError(res, error);
  }
};
