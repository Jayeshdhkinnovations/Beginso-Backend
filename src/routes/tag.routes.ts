import { Router } from "express";
import { getTags, createTag, updateTag, deleteTag, mergeTag } from "../controllers/tag.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

// mergeParams: true allows accessing :id or :workspaceId from the parent router. Tag's own id
// param is deliberately named :tagId (not :id) to avoid shadowing the parent workspace :id param
// — the same collision yesterday's stage routes had to be written around.
const router = Router({ mergeParams: true });

router.get(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:read", { resourceType: "workspace" }) as any,
  getTags
);

// OQ-5: any member with responses:write (this repo's "can edit responses" tier) may create a tag
// inline. Owner/Admin below for rename/recolour/merge/delete.
router.post(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("responses:write", { resourceType: "workspace" }) as any,
  createTag
);

router.patch(
  "/:tagId",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  updateTag
);

router.delete(
  "/:tagId",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  deleteTag
);

router.post(
  "/:tagId/merge",
  protect as any,
  blockSuspended as any,
  requirePermission("workspace:settings", { resourceType: "workspace" }) as any,
  mergeTag
);

export default router;
