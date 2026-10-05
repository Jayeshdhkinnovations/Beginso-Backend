import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { publicTemplatesRateLimiter } from "../middleware/rateLimiter";
import { getTemplates, getPublicTemplates, useTemplate, publishTemplate, removeTemplate } from "../controllers/template.controller";

const router = Router();

// GET /api/templates/public - Public template gallery (no auth, rate-limited)
router.get("/public", publicTemplatesRateLimiter, getPublicTemplates);

// GET /api/templates - Get all active templates (authenticated)
router.get("/", protect as any, blockSuspended as any, requirePermission("templates:read") as any, getTemplates);

// POST /api/templates - publish a form to the workspace's templates (Editor and above)
router.post("/", protect as any, blockSuspended as any, requirePermission("forms:create") as any, publishTemplate);

// DELETE /api/templates/:id - remove a workspace template (Owner/Admin; checked against the template's workspace)
router.delete("/:id", protect as any, blockSuspended as any, removeTemplate);

// POST /api/templates/:id/use - Create a form from a template
router.post("/:id/use", protect as any, blockSuspended as any, (req, res, next) => {
  // useTemplate checks permission on explicit destinations. Ambient headers or
  // default-workspace roles must not override the requested destination.
  if (req.body?.destinationWorkspaceId !== undefined) return next();
  return requirePermission("forms:create")(req, res, next);
}, useTemplate);

export default router;

