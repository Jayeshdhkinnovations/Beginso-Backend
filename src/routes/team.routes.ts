import { Router } from "express";
import {
  listMembers,
  updateMemberRole,
  removeMember,
} from "../controllers/team.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

// mergeParams: true allows accessing :id or :workspaceId from the parent router
const router = Router({ mergeParams: true });

router.get(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:read", { resourceType: "workspace" }) as any,
  listMembers
);

router.patch(
  "/:memberId",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  updateMemberRole
);

router.put(
  "/:memberId",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  updateMemberRole
);

router.delete(
  "/:memberId",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  removeMember
);

export default router;
