import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { getTrash, restoreTrashItem, purgeTrashItem, emptyTrashHandler } from "../controllers/trash.controller";

const router = Router();

// Sprint 13 (CF5.5). Viewing Trash needs the Owner/Admin tier (responses:delete); the finer per-type rules
// (forms: Owner only; responses: Owner or Admin) are applied in trash.service.ts against the caller's role.
// In personal space the caller is the owner of their own forms and is never restricted.
const gate = [protect as any, blockSuspended as any, requirePermission("responses:delete") as any];

router.get("/", ...gate, getTrash);
router.post("/:type/:id/restore", ...gate, restoreTrashItem);
router.delete("/:type/:id", ...gate, purgeTrashItem);
router.delete("/", ...gate, emptyTrashHandler);

export default router;
