import { Router } from "express";
import {
  getStats,
  getAbuse,
  getLogs,
  getMailLogs,
  getAdmins,
  getAdminDetail,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  getAuditLogs,
  updateAdminLimits,
  getOverQuota,
  reconcileStorage,
} from "../controllers/superadmin.controller";
import * as ops from "../controllers/superadminOps.controller";
import { protect, requireSuperAdmin } from "../middleware/auth.middleware";

const router = Router();

// Protect all routes in this router with both protect and requireSuperAdmin guards
router.use(protect as any, requireSuperAdmin as any);

router.get("/stats", getStats);
router.get("/abuse", getAbuse);
router.get("/logs", getLogs);
router.get("/mail-logs", getMailLogs);
router.get("/admins", getAdmins);
router.get("/admins/:id", getAdminDetail);
router.post("/admins", createAdmin);
router.patch("/admins/:id", updateAdmin);
router.patch("/admins/:id/limits", updateAdminLimits);
router.delete("/admins/:id", deleteAdmin);
router.get("/storage/over-quota", getOverQuota);
router.post("/storage/reconcile", reconcileStorage);
router.get("/audit", getAuditLogs);

// Admin sessions (operator revoke), storage, workspaces, built-in templates, health, export jobs.
router.get("/admins/:id/sessions", ops.listUserSessions);
router.delete("/admins/:id/sessions", ops.revokeAllUserSessions);
router.delete("/admins/:id/sessions/:sessionId", ops.revokeUserSession);
router.get("/storage", ops.getStorage);
router.get("/workspaces", ops.listWorkspaces);
router.get("/workspaces/:id", ops.getWorkspace);
router.delete("/workspaces/:id", ops.deleteWorkspace);
router.get("/templates", ops.listTemplates);
router.post("/templates", ops.createTemplate);
router.patch("/templates/:id", ops.updateTemplate);
router.delete("/templates/:id", ops.deleteTemplate);
router.get("/health", ops.getHealth);
router.get("/exports", ops.listExports);
router.post("/exports/:id/retry", ops.retryExport);

export default router;
