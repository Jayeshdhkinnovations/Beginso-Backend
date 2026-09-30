import { Router } from "express";
import {
  getScoreCriteria,
  createScoreCriterion,
  updateScoreCriterion,
  deleteScoreCriterion,
  reorderScoreCriteria,
} from "../controllers/scoreCriterion.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

// mergeParams: true allows accessing :id or :workspaceId from the parent router
const router = Router({ mergeParams: true });

router.get(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:read", { resourceType: "workspace" }) as any,
  getScoreCriteria
);

// Owner/Admin only below, same as stage.routes.ts's workspace:settings gate.
router.post(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  createScoreCriterion
);

router.patch(
  "/order",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  reorderScoreCriteria
);

router.patch(
  "/:criterionId",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  updateScoreCriterion
);

router.delete(
  "/:criterionId",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  deleteScoreCriterion
);

export default router;
