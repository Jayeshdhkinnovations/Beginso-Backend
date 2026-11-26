import { Router } from "express";
import {
  getStats,
  getAbuse,
  getLogs,
  getMailLogs,
  getAdmins,
  getAdminDetail,
  getAdminActivityFeed,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  getAuditLogs,
  updateAdminLimits,
  getOverQuota,
  reconcileStorage,
} from "../controllers/superadmin.controller";
import * as ops from "../controllers/superadminOps.controller";
import * as metrics from "../controllers/adminMetrics.controller";
import { userActionRateLimiter } from "../middleware/rateLimiter";
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
router.get("/admins/:id/activity", getAdminActivityFeed);
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
router.get("/forms", ops.listForms);
router.get("/templates", ops.listTemplates);
router.post("/templates", ops.createTemplate);
router.patch("/templates/:id", ops.updateTemplate);
router.delete("/templates/:id", ops.deleteTemplate);
router.get("/health", ops.getHealth);
router.get("/exports", ops.listExports);
router.post("/exports/:id/retry", ops.retryExport);

// Read-only metrics for Overview and Insights (see the comments in this file): aggregations, cached for 60 seconds, limited to 60 requests a minute per user.
const metricsLimit = userActionRateLimiter("admin-metrics", 60, 60 * 1000);
router.get("/metrics/overview", metricsLimit, metrics.getOverviewMetrics);
router.get("/metrics/growth", metricsLimit, metrics.getGrowthMetrics);
router.get("/metrics/engagement", metricsLimit, metrics.getEngagementMetrics);
router.get("/metrics/usage", metricsLimit, metrics.getUsageMetrics);
router.get("/metrics/attention", metricsLimit, metrics.getAttentionMetrics);
router.get("/metrics/mail", metricsLimit, metrics.getMailMetrics);

export default router;
