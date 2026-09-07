import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Membership from "../models/Membership";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Report from "../models/Report";
import SessionModel from "../models/Session";
import { WorkspaceRole } from "../types/workspace.types";

export interface RequirePermissionOptions {
  resourceType?: "workspace" | "form" | "response" | "report" | "upload" | "session" | "template";
  extractWorkspaceId?: (req: Request) => Promise<string | null> | string | null;
}

export const ROLE_PERMISSIONS: Record<WorkspaceRole, string[]> = {
  owner: ["*"],
  admin: [
    "workspace:read",
    "workspace:settings",
    "workspace:export",
    "forms:*",
    "responses:*",
    "dashboard:*",
    "analytics:*",
    "reports:*",
    "templates:*",
    "uploads:*",
    "team:*",
    "sessions:*",
  ],
  editor: [
    "workspace:read",
    "forms:read",
    "forms:create",
    "forms:write",
    "forms:publish",
    "forms:delete",
    "responses:read",
    "responses:write",
    "dashboard:read",
    "analytics:read",
    "reports:read",
    "reports:create",
    "templates:read",
    "uploads:create",
    "uploads:read",
    "sessions:read",
  ],
  member: [
    "workspace:read",
    "forms:read",
    "forms:create",
    "forms:write",
    "forms:publish",
    "forms:delete",
    "responses:read",
    "responses:write",
    "dashboard:read",
    "analytics:read",
    "reports:read",
    "reports:create",
    "templates:read",
    "uploads:create",
    "uploads:read",
    "sessions:read",
  ],
  reviewer: [
    "workspace:read",
    "forms:read",
    "responses:read",
    "dashboard:read",
    "analytics:read",
    "reports:read",
    "templates:read",
    "uploads:read",
    "sessions:read",
  ],
  viewer: [
    "workspace:read",
    "forms:read",
    "responses:read",
    "dashboard:read",
    "analytics:read",
    "reports:read",
    "templates:read",
    "uploads:read",
    "sessions:read",
  ],
};

export const hasPermission = (role: WorkspaceRole, requiredPermission?: string): boolean => {
  if (!requiredPermission) return true;
  const permissions = ROLE_PERMISSIONS[role] || [];
  if (permissions.includes("*")) return true;
  if (permissions.includes(requiredPermission)) return true;

  // Resource-level wildcard match (e.g., 'forms:*' matches 'forms:read')
  const [resource] = requiredPermission.split(":");
  if (permissions.includes(`${resource}:*`)) return true;

  return false;
};

export const requirePermission = (
  permission?: string,
  options?: RequirePermissionOptions
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as any;
      if (!authReq.user) {
        res.status(401).json({
          success: false,
          message: "Not authorized",
          error: { message: "Not authorized" },
        });
        return;
      }

      const user = authReq.user;

      // Super admin platform-wide bypass
      if (user.role === "super_admin") {
        return next();
      }

      // Check session ownership if resourceType is 'session'
      if (options?.resourceType === "session" && req.params.id) {
        const sessionId = String(req.params.id);
        if (mongoose.Types.ObjectId.isValid(sessionId)) {
          const sessionDoc = await SessionModel.findById(sessionId);
          if (sessionDoc && sessionDoc.userId.toString() !== user._id.toString()) {
            res.status(403).json({
              success: false,
              message: "Forbidden: Cross-user session access denied",
              error: {
                code: "FORBIDDEN_SESSION_ACCESS",
                message: "Forbidden: Cross-user session access denied",
              },
            });
            return;
          }
        }
      }

      // 1. Resolve target workspace ID
      let targetWorkspaceId: string | null = null;

      if (options?.extractWorkspaceId) {
        targetWorkspaceId = await options.extractWorkspaceId(req);
      }

      // Header scoping: x-workspace-id
      if (!targetWorkspaceId && req.headers["x-workspace-id"]) {
        const headerVal = req.headers["x-workspace-id"];
        const rawId = Array.isArray(headerVal) ? headerVal[0] : headerVal;
        if (rawId && typeof rawId === "string" && mongoose.Types.ObjectId.isValid(rawId.trim())) {
          targetWorkspaceId = rawId.trim();
        }
      }

      // Header scoping: x-workspace-slug
      if (!targetWorkspaceId && req.headers["x-workspace-slug"]) {
        const slugHeader = req.headers["x-workspace-slug"];
        const rawSlug = Array.isArray(slugHeader) ? slugHeader[0] : slugHeader;
        if (rawSlug && typeof rawSlug === "string") {
          const ws = await Workspace.findOne({ slug: rawSlug.trim().toLowerCase() }).select("_id").lean();
          if (ws) {
            targetWorkspaceId = ws._id.toString();
          }
        }
      }

      // Resource-based workspace resolution
      if (!targetWorkspaceId && options?.resourceType) {
        const rawParam = req.params.formId || req.params.responseId || req.params.reportId || req.params.workspaceId || req.params.id;
        const paramId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
        if (paramId && typeof paramId === "string") {
          if (options.resourceType === "workspace") {
            if (mongoose.Types.ObjectId.isValid(paramId)) {
              targetWorkspaceId = paramId;
            } else {
              const ws = await Workspace.findOne({ slug: paramId.trim().toLowerCase() }).select("_id").lean();
              if (ws) {
                targetWorkspaceId = ws._id.toString();
              }
            }
          } else if (mongoose.Types.ObjectId.isValid(paramId)) {
            if (options.resourceType === "form") {
              const form = await Form.findById(paramId).select("workspaceId").lean();
              if (form && form.workspaceId) {
                targetWorkspaceId = form.workspaceId.toString();
              }
            }
          } else if (options.resourceType === "response") {
            const resp = await ResponseModel.findById(paramId).select("formId").lean();
            if (resp && resp.formId) {
              const form = await Form.findById(resp.formId).select("workspaceId").lean();
              if (form && form.workspaceId) {
                targetWorkspaceId = form.workspaceId.toString();
              }
            }
          } else if (options.resourceType === "report") {
            const report = await Report.findById(paramId).select("workspaceId").lean();
            if (report && report.workspaceId) {
              targetWorkspaceId = report.workspaceId.toString();
            }
          }
        }
      }

      // Query param scoping
      if (!targetWorkspaceId && req.query.workspaceId && typeof req.query.workspaceId === "string") {
        if (mongoose.Types.ObjectId.isValid(req.query.workspaceId)) {
          targetWorkspaceId = req.query.workspaceId;
        }
      }

      // Body destination workspace scoping (e.g. create form destination)
      if (!targetWorkspaceId && req.body && (req.body.destinationWorkspaceId || (options?.resourceType !== "form" && req.body.workspaceId))) {
        const bodyWs = req.body.destinationWorkspaceId || req.body.workspaceId;
        if (bodyWs && typeof bodyWs === "string" && mongoose.Types.ObjectId.isValid(bodyWs.trim())) {
          targetWorkspaceId = bodyWs.trim();
        }
      }

      // Fallback: caller's active workspace or default membership/ownership
      if (!targetWorkspaceId) {
        if (user.workspaceId) {
          targetWorkspaceId = user.workspaceId._id ? user.workspaceId._id.toString() : user.workspaceId.toString();
        } else {
          const membership = await Membership.findOne({ userId: user._id }).select("workspaceId").lean();
          if (membership && membership.workspaceId) {
            targetWorkspaceId = membership.workspaceId.toString();
          } else {
            const owned = await Workspace.findOne({ owner: user._id }).select("_id").lean();
            if (owned) {
              targetWorkspaceId = owned._id.toString();
            }
          }
        }
      }

      // 2. Validate membership / ownership if a target workspace was identified
      if (targetWorkspaceId) {
        const workspaceDoc = await Workspace.findById(targetWorkspaceId).select("_id owner").lean();
        if (!workspaceDoc) {
          res.status(404).json({
            success: false,
            message: "Workspace not found",
            error: {
              code: "WORKSPACE_NOT_FOUND",
              message: "Workspace not found",
            },
          });
          return;
        }

        const membership = await Membership.findOne({
          userId: user._id,
          workspaceId: targetWorkspaceId,
        });

        let effectiveRole: WorkspaceRole | null = membership ? membership.role : null;

        // Fallback for V1 legacy workspaces where membership row isn't migrated yet
        if (!effectiveRole) {
          const isOwner = workspaceDoc.owner.toString() === user._id.toString();
          if (isOwner) {
            effectiveRole = "owner";
          } else if (user.workspaceId && user.workspaceId.toString() === targetWorkspaceId.toString()) {
            effectiveRole = "admin";
          }
        }

        // Cross-workspace violation: user has neither membership nor ownership in target workspace
        if (!effectiveRole) {
          res.status(403).json({
            success: false,
            message: "Forbidden: Cross-workspace access denied",
            error: {
              code: "FORBIDDEN_WORKSPACE_ACCESS",
              message: "Forbidden: Cross-workspace access denied",
            },
          });
          return;
        }

        // Check required permission against effective role
        if (permission && !hasPermission(effectiveRole, permission)) {
          res.status(403).json({
            success: false,
            message: "Forbidden: Insufficient permissions for this action",
            error: {
              code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS",
              message: "Forbidden: Insufficient permissions",
            },
          });
          return;
        }

        // Enrich request context for downstream handlers and Sprint 9 membership scoping
        authReq.workspaceId = targetWorkspaceId;
        authReq.membership = membership || null;
        authReq.membershipId = membership?._id?.toString() || null;
        authReq.workspaceRole = effectiveRole;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
