import { Request, Response } from "express";
import Membership from "../models/Membership";
import Workspace from "../models/Workspace";

// The workspace requirePermission verified for this request, or "" when there is none (no
// workspace at all, or an explicit personal context). Handlers must scope tenant data by this and
// never by user.workspaceId, the URL, the body or the query: those are what the caller controls.
export const getVerifiedWorkspaceId = async (req: Request): Promise<string> => {
  const authReq = req as any;
  if (typeof authReq.workspaceId === "string") return authReq.workspaceId;
  if (authReq.workspaceId === null || authReq.user?.role !== "super_admin") return "";

  // super_admin skips requirePermission, so nothing was resolved: use their own default workspace.
  const user = authReq.user;
  if (user.workspaceId) return String(user.workspaceId._id ?? user.workspaceId);
  const membership = await Membership.findOne({ userId: user._id }).select("workspaceId").lean();
  if (membership?.workspaceId) return membership.workspaceId.toString();
  const owned = await Workspace.findOne({ owner: user._id }).select("_id").lean();
  return owned ? owned._id.toString() : "";
};

// For handlers that address a workspace by URL param: it must be the workspace the middleware
// verified, otherwise the permission check and the action would be about different tenants.
export const assertVerifiedWorkspace = (req: Request, res: Response, workspaceId: unknown): boolean => {
  const authReq = req as any;
  if (authReq.user?.role === "super_admin" || authReq.workspaceId === String(workspaceId)) return true;
  res.status(403).json({
    success: false,
    message: "Forbidden: Cross-workspace access denied",
    error: { code: "FORBIDDEN_WORKSPACE_ACCESS", message: "Forbidden: Cross-workspace access denied" },
  });
  return false;
};
