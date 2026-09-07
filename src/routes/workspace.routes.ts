import { Router } from "express";
import { createWorkspace, listWorkspaces, getWorkspace, updateWorkspace, deleteWorkspace } from "../controllers/workspace.controller";
import {
  getCurrentWorkspace,
  patchCurrentWorkspace,
  createWorkspaceExport,
  getWorkspaceExportStatus,
  downloadWorkspaceExportFile,
  deleteCurrentWorkspace,
} from "../controllers/workspace_settings.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

const router = Router();

router.get("/current", protect as any, blockSuspended as any, requirePermission("workspace:read") as any, getCurrentWorkspace);
router.patch("/current", protect as any, blockSuspended as any, requirePermission("workspace:settings") as any, patchCurrentWorkspace);
router.post("/current/export", protect as any, blockSuspended as any, requirePermission("workspace:export") as any, createWorkspaceExport);
router.get("/current/export/status", protect as any, blockSuspended as any, requirePermission("workspace:export") as any, getWorkspaceExportStatus);
router.get("/current/export/file", protect as any, blockSuspended as any, requirePermission("workspace:export") as any, downloadWorkspaceExportFile);
router.delete("/current", protect as any, blockSuspended as any, requirePermission("workspace:delete") as any, deleteCurrentWorkspace);

router.get("/", protect as any, blockSuspended as any, listWorkspaces);
router.post("/", protect as any, blockSuspended as any, createWorkspace);
router.get("/:id", protect as any, blockSuspended as any, requirePermission("workspace:read", { resourceType: "workspace" }) as any, getWorkspace);
router.put("/:id", protect as any, blockSuspended as any, requirePermission("workspace:settings", { resourceType: "workspace" }) as any, updateWorkspace);
router.delete("/:id", protect as any, blockSuspended as any, requirePermission("workspace:delete", { resourceType: "workspace" }) as any, deleteWorkspace);

export default router;
