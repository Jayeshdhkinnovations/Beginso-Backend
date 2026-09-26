import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { publicTemplatesRateLimiter } from "../middleware/rateLimiter";
import { getTemplates, getPublicTemplates, useTemplate } from "../controllers/template.controller";

const router = Router();

// GET /api/templates/public - Public template gallery (no auth, rate-limited)
router.get("/public", publicTemplatesRateLimiter, getPublicTemplates);

// GET /api/templates - Get all active templates (authenticated)
router.get("/", protect as any, blockSuspended as any, requirePermission("templates:read") as any, getTemplates);

// POST /api/templates/:id/use - Create a form from a template
router.post("/:id/use", protect as any, blockSuspended as any, requirePermission("forms:create") as any, useTemplate);

export default router;

