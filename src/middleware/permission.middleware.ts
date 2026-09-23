import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Membership from "../models/Membership";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Report from "../models/Report";
import SessionModel from "../models/Session";
import FormAccessGrant from "../models/FormAccessGrant";
import Invitation from "../models/Invitation";
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
    "workspace:audit",
    "forms:read",
    "forms:create",
    "forms:write",
    "forms:publish",
    // NOTE: forms:delete is strictly OWNER ONLY! Admin does NOT have forms:delete or forms:*
    "responses:*",
    "responses:read",
    "responses:write",
    "responses:delete",
    "dashboard:*",
    "analytics:*",
    "reports:*",
    "reports:read",
    "reports:create",
    "templates:*",
    "templates:read",
    "templates:create",
    "uploads:*",
    "uploads:read",
    "uploads:create",
    "team:*",
    "team:read",
    "team:manage",
    "sessions:*",
  ],
  editor: [
    "workspace:read",
    "forms:read",
    "forms:create",
    "forms:write",
    // No forms:publish, no forms:delete
    "responses:read",
    "responses:write",
    // No responses:delete
    "dashboard:read",
    "analytics:read",
    "reports:read",
    "reports:create", // Can export
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
    // No forms:publish, no forms:delete
    "responses:read",
    "responses:write",
    // No responses:delete
    "dashboard:read",
    "analytics:read",
    "reports:read",
    "reports:create", // Can export
    "templates:read",
    "uploads:create",
    "uploads:read",
    "sessions:read",
  ],
  reviewer: [
    "workspace:read",
    "forms:read",
    // No forms:create, forms:write, forms:publish, forms:delete
    "responses:read",
    // No responses:write, responses:delete
    // No reports:create (cannot export per C2.1 role matrix)
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

  // Resource-level wildcard match (e.g., 'responses:*' matches 'responses:read')
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

      // Check for Per-Form Access Grant (BE 0.6) before workspace checks
      // Works identically whether form's workspaceId is set or null (personal form)
      if (options?.resourceType === "form" || options?.resourceType === "response") {
        const rawParam = req.params.formId || req.params.responseId || req.params.id;
        const paramId = Array.isArray(rawParam) ? rawParam[0] : rawParam;

        if (paramId && typeof paramId === "string" && mongoose.Types.ObjectId.isValid(paramId)) {
          let targetForm: any = null;

          if (options.resourceType === "form") {
            targetForm = await Form.findById(paramId).select("_id workspaceId").lean();
          } else if (options.resourceType === "response") {
            const resp = await ResponseModel.findById(paramId).select("formId").lean();
            if (resp && resp.formId) {
              targetForm = await Form.findById(resp.formId).select("_id workspaceId").lean();
            }
          }

          if (targetForm) {
            // Check if user has direct per-form grant
            const grant = await FormAccessGrant.findOne({
              formId: targetForm._id,
              userId: user._id,
            }).lean();

            if (grant) {
              // Check permission against grant's role
              if (permission && !hasPermission(grant.role, permission)) {
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

              // Caller authorized via per-form grant!
              authReq.workspaceId = targetForm.workspaceId ? targetForm.workspaceId.toString() : null;
              authReq.formAccessGrant = grant;
              authReq.workspaceRole = grant.role;
              authReq.membership = null;
              authReq.membershipId = null;
              return next();
            }
          }
        }
      }

      // Explicit personal-space signal: "personal"/"null"/"none"/"personal-only" in the x-workspace-id or
      // x-workspace-slug header, workspaceId query param, or body destination, means the caller is
      // deliberately operating in their personal (workspaceId: null) context and must NOT fall
      // back to their default workspace below — otherwise a member of any workspace could
      // never actually see/create in their personal space, and personal forms silently
      // resolve into the wrong context on list/stat/create endpoints.
      const isPersonalSignal = (val: unknown): boolean => {
        if (val === null) return true;
        const raw = Array.isArray(val) ? val[0] : val;
        if (raw === null) return true;
        if (typeof raw === "string") {
          return ["personal", "null", "none", "personal-only"].includes(raw.trim().toLowerCase());
        }
        if (typeof raw === "object" && raw !== null) {
          if ((raw as any).type === "personal" || (raw as any).workspaceId === null || (raw as any).destinationWorkspaceId === null) {
            return true;
          }
        }
        return false;
      };

      const hasExplicitPersonalSignal =
        isPersonalSignal(req.headers["x-workspace-id"]) ||
        isPersonalSignal(req.headers["x-workspace-slug"]) ||
        isPersonalSignal(req.query.workspaceId) ||
        (req.body && (
          isPersonalSignal(req.body.destination) ||
          (req.body.destinationWorkspaceId !== undefined && isPersonalSignal(req.body.destinationWorkspaceId)) ||
          (req.body.workspaceId !== undefined && isPersonalSignal(req.body.workspaceId))
        ));

      if (hasExplicitPersonalSignal) {
        authReq.workspaceId = null;
        authReq.explicitPersonalContext = true;
        authReq.membership = null;
        authReq.membershipId = null;
        authReq.workspaceRole = null;
        next();
        return;
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
        const rawParam =
          req.params.workspaceId ||
          req.params.formId ||
          req.params.responseId ||
          req.params.reportId ||
          req.params.invitationId ||
          req.params.id ||
          req.params.token;
        const paramId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
        if (paramId && typeof paramId === "string") {
          if (options.resourceType === "workspace") {
            if (mongoose.Types.ObjectId.isValid(paramId)) {
              const ws = await Workspace.findById(paramId).select("_id").lean();
              if (ws) {
                targetWorkspaceId = ws._id.toString();
              } else {
                // Check if paramId happens to be an invitation ID shadowing workspace :id
                const inv = await Invitation.findById(paramId).select("workspaceId").lean();
                if (inv && inv.workspaceId) {
                  targetWorkspaceId = inv.workspaceId.toString();
                }
              }
            } else {
              const ws = await Workspace.findOne({ slug: paramId.trim().toLowerCase() }).select("_id").lean();
              if (ws) {
                targetWorkspaceId = ws._id.toString();
              } else {
                // Check if paramId happens to be an invitation token
                const inv = await Invitation.findOne({ token: paramId.trim() }).select("workspaceId").lean();
                if (inv && inv.workspaceId) {
                  targetWorkspaceId = inv.workspaceId.toString();
                }
              }
            }
          } else if (mongoose.Types.ObjectId.isValid(paramId)) {
            if (options.resourceType === "form") {
              const form = await Form.findById(paramId).select("workspaceId").lean();
              if (form && form.workspaceId) {
                targetWorkspaceId = form.workspaceId.toString();
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
