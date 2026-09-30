import { Router } from "express";
import { updateMyPreferences, createWorkspace, listWorkspaces, getWorkspace, updateWorkspace, deleteWorkspace, transferOwnership, leaveWorkspace } from "../controllers/workspace.controller";
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

import teamRoutes from "./team.routes";
import invitationRoutes from "./invitation.routes";
import stageRoutes from "./stage.routes";
import tagRoutes from "./tag.routes";
import scoreCriterionRoutes from "./scoreCriterion.routes";

import { listWorkspaceActivity, listWorkspaceAudit } from "../controllers/event.controller";

const router = Router();

// Sub-routes for workspace members and invitations
router.use("/:id/members", teamRoutes);
router.use("/:workspaceId/members", teamRoutes);
router.use("/:id/invitations", invitationRoutes);
router.use("/:workspaceId/invitations", invitationRoutes);
// Pipeline stages (Sprint 12, BE 0.1)
router.use("/:id/stages", stageRoutes);
router.use("/:workspaceId/stages", stageRoutes);
// Tags (Sprint 12, BE 0.2)
router.use("/:id/tags", tagRoutes);
router.use("/:workspaceId/tags", tagRoutes);
// Scoring criteria (Sprint 12, BE 0.5 / B6.1, OQ-7 resolved 3 Oct 2026)
router.use("/:id/score-criteria", scoreCriterionRoutes);
router.use("/:workspaceId/score-criteria", scoreCriterionRoutes);

// Activity Feed & Audit Log routes (BE 0.3 / BE 0.4)
router.get("/:id/events", protect as any, blockSuspended as any, requirePermission("workspace:read", { resourceType: "workspace" }) as any, listWorkspaceActivity);
router.get("/:workspaceId/events", protect as any, blockSuspended as any, requirePermission("workspace:read", { resourceType: "workspace" }) as any, listWorkspaceActivity);
router.get("/:id/audit", protect as any, blockSuspended as any, requirePermission("workspace:audit", { resourceType: "workspace" }) as any, listWorkspaceAudit);
router.get("/:workspaceId/audit", protect as any, blockSuspended as any, requirePermission("workspace:audit", { resourceType: "workspace" }) as any, listWorkspaceAudit);

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
router.post("/:id/transfer-ownership", protect as any, blockSuspended as any, requirePermission("workspace:delete", { resourceType: "workspace" }) as any, transferOwnership);
router.patch("/:id/preferences", protect as any, blockSuspended as any, requirePermission("workspace:read", { resourceType: "workspace" }) as any, updateMyPreferences);
router.post("/:id/leave", protect as any, blockSuspended as any, requirePermission("workspace:read", { resourceType: "workspace" }) as any, leaveWorkspace);

export default router;
