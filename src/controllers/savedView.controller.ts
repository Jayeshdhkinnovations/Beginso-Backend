import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import User from "../models/User";
import { SavedViewService } from "../services/savedView.service";
import { getVerifiedWorkspaceId } from "../utils/requestContext";
import { createSavedViewSchema, updateSavedViewSchema } from "../validations/savedView.validator";

const savedViewService = new SavedViewService();

// Requirements.md §14 / OQ-8 default: team-view creation is Editor+; rename/visibility/delete of
// a team view is Admin+ (Owner included via "*" elsewhere in this codebase's role checks).
const TEAM_VIEW_CREATE_ROLES = new Set(["owner", "admin", "editor"]);
const TEAM_VIEW_ADMIN_ROLES = new Set(["owner", "admin"]);

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

// `workspaceId` scope: `null` for the caller's Personal shell (explicit signal or no workspace
// resolved at all — mirrors response.controller.ts's own personal-shell handling from today),
// otherwise the verified workspace id. Never a silent fallback to some other workspace (OQ-1).
async function resolveScope(req: Request): Promise<string | null> {
  const workspaceId = await getVerifiedWorkspaceId(req);
  return workspaceId || null;
}

export const listSavedViews = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const workspaceId = await resolveScope(req);
    const formId = req.query.formId ? String(req.query.formId) : null;

    const views = await savedViewService.listViews(workspaceId, formId, authReq.user._id.toString());
    // Batch-resolve owner display names (service returns "Unknown" placeholders otherwise).
    const ownerIds = [...new Set(views.map((v) => v.ownerId))];
    const owners = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).select("fullName email").lean() : [];
    const nameById = new Map(owners.map((o) => [o._id.toString(), o.fullName || o.email]));
    const withNames = views.map((v) => ({ ...v, ownerName: nameById.get(v.ownerId) ?? v.ownerName }));

    res.status(200).json({ success: true, views: withNames, data: withNames });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const createSavedView = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const workspaceId = await resolveScope(req);
    const parsed = createSavedViewSchema.parse(req.body);
    const canCreateTeamView = !!authReq.workspaceRole && TEAM_VIEW_CREATE_ROLES.has(authReq.workspaceRole);

    const view = await savedViewService.createView(
      workspaceId,
      authReq.user._id.toString(),
      authReq.user.fullName || authReq.user.email,
      canCreateTeamView,
      parsed
    );

    res.status(201).json({ success: true, message: "Saved view created", view, data: view });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const updateSavedView = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const parsed = updateSavedViewSchema.parse(req.body);
    const isAdminPlus = !!authReq.workspaceRole && TEAM_VIEW_ADMIN_ROLES.has(authReq.workspaceRole);

    const view = await savedViewService.updateView(
      String(req.params.id),
      authReq.user._id.toString(),
      isAdminPlus,
      authReq.user.fullName || authReq.user.email,
      parsed
    );

    res.status(200).json({ success: true, message: "Saved view updated", view, data: view });
  } catch (error: any) {
    sendError(res, error);
  }
};

export const deleteSavedView = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const isAdminPlus = !!authReq.workspaceRole && TEAM_VIEW_ADMIN_ROLES.has(authReq.workspaceRole);
    await savedViewService.removeView(String(req.params.id), authReq.user._id.toString(), isAdminPlus);
    res.status(204).send();
  } catch (error: any) {
    sendError(res, error);
  }
};
