import { Router, Request, Response, NextFunction } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { getHome, putHome, deleteHome } from "../controllers/dashboardLayout.controller";

const router = Router();

// Scope must be explicit: requirePermission would otherwise fall back to the caller's default workspace.
const requireScopeHeader = (req: Request, res: Response, next: NextFunction) => {
  if (!req.headers["x-workspace-slug"]) {
    res.status(400).json({
      success: false,
      message: "x-workspace-slug header is required ('personal' for personal scope)",
      error: { code: "SCOPE_REQUIRED", message: "x-workspace-slug header is required" },
    });
    return;
  }
  next();
};

const guard = [protect as any, blockSuspended as any, requireScopeHeader, requirePermission("dashboard:read") as any];

router.get("/home", ...guard, getHome);
router.put("/home", ...guard, putHome);
router.delete("/home", ...guard, deleteHome);

export default router;
