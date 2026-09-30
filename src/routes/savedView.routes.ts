import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { listSavedViews, createSavedView, updateSavedView, deleteSavedView } from "../controllers/savedView.controller";

const router = Router();

// Sprint 12, BE 0.4. Top-level `/api/views`, scoped by `x-workspace-slug` (or Personal) exactly
// like `/api/responses` — not nested under `/api/workspaces/:id`, matching the frontend contract
// (`viewsService`, design.md §11.2). No `resourceType` option: there's no `:id`-shaped resource
// param on GET/POST to resolve a workspace from, so scope comes purely from the header, same as
// `response.routes.ts`'s own top-level list/stats routes.
router.get("/", protect as any, blockSuspended as any, requirePermission("responses:read") as any, listSavedViews);
router.post("/", protect as any, blockSuspended as any, requirePermission("responses:read") as any, createSavedView);
router.patch("/:id", protect as any, blockSuspended as any, requirePermission("responses:read") as any, updateSavedView);
router.delete("/:id", protect as any, blockSuspended as any, requirePermission("responses:read") as any, deleteSavedView);

export default router;
