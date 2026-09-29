import { Router } from "express";
import {
  getStages,
  createStage,
  updateStage,
  deleteStage,
  reorderStages,
} from "../controllers/stage.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

// mergeParams: true allows accessing :id or :workspaceId from the parent router
const router = Router({ mergeParams: true });

router.get(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:read", { resourceType: "workspace" }) as any,
  getStages
);

// Owner/Admin only below. workspace:settings is the existing permission both roles hold and
// editor/member/reviewer/viewer do not (see ROLE_PERMISSIONS in permission.middleware.ts).
router.post(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  createStage
);

router.patch(
  "/order",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  reorderStages
);

router.patch(
  "/:stageId",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  updateStage
);

router.delete(
  "/:stageId",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  deleteStage
);

export default router;
