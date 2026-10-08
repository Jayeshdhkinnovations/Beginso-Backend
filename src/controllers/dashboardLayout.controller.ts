import { Request, Response } from "express";
import { ZodError } from "zod";
import { DashboardLayoutService } from "../services/dashboardLayout.service";
import { getVerifiedWorkspaceId } from "../utils/requestContext";
import { hasPermission } from "../middleware/permission.middleware";
import { putDashboardSchema } from "../validations/dashboard.validator";

const service = new DashboardLayoutService();

const fail = (res: Response, status: number, message: string, code?: string, extra: object = {}) =>
  res.status(status).json({ success: false, message, error: { code, message }, ...(code ? { code } : {}), ...extra });

const handle = (res: Response, error: any) => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
      error: { message: "Validation failed" },
    });
  }
  return fail(res, error.statusCode || 500, error.message || "Internal server error");
};

// Workspace-scope writes need dashboard:manage; personal scope (no workspace) is always the caller's own.
const canWrite = (req: Request, workspaceId: string | null) => {
  const a = req as any;
  return !workspaceId || a.user?.role === "super_admin" || hasPermission(a.workspaceRole, "dashboard:manage");
};

export const getHome = async (req: Request, res: Response) => {
  try {
    const ws = (await getVerifiedWorkspaceId(req)) || null;
    const dashboard = await service.get(ws, (req as any).user._id.toString());
    res.json({ success: true, dashboard });
  } catch (e) {
    handle(res, e);
  }
};

export const putHome = async (req: Request, res: Response) => {
  try {
    const ws = (await getVerifiedWorkspaceId(req)) || null;
    if (!canWrite(req, ws)) return fail(res, 403, "Forbidden: Insufficient permissions", "FORBIDDEN_INSUFFICIENT_PERMISSIONS");
    const { widgets, version } = putDashboardSchema.parse(req.body);
    const r = await service.put(ws, (req as any).user._id.toString(), widgets, version);
    if ("conflict" in r) {
      return fail(res, 409, "Dashboard was changed elsewhere", "VERSION_CONFLICT", { dashboard: r.conflict });
    }
    res.json({ success: true, dashboard: r.dashboard });
  } catch (e) {
    handle(res, e);
  }
};

export const deleteHome = async (req: Request, res: Response) => {
  try {
    const ws = (await getVerifiedWorkspaceId(req)) || null;
    if (!canWrite(req, ws)) return fail(res, 403, "Forbidden: Insufficient permissions", "FORBIDDEN_INSUFFICIENT_PERMISSIONS");
    await service.remove(ws, (req as any).user._id.toString());
    res.json({ success: true });
  } catch (e) {
    handle(res, e);
  }
};
