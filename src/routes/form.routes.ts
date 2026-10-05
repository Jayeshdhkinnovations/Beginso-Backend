import { Router } from "express";
import {
  createForm,
  getForm,
  listForms,
  updateForm,
  patchForm,
  deleteForm,
  submitForm,
  getSubmissions,
  duplicateForm,
  publishForm,
  closeForm,
  moveForm,
  listFormGrants,
  createFormGrant,
  revokeFormGrant,
  getFormOverview,
} from "../controllers/form.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

import { listFormEvents } from "../controllers/event.controller";
import {
  getReadiness,
  unpublishForm,
  regenerateLink,
  archiveForm,
  unarchiveForm,
  createTestSubmission,
} from "../controllers/formLifecycle.controller";
import { getScoreComparison } from "../controllers/score.controller";

const router = Router();

router.post("/", protect as any, blockSuspended as any, requirePermission("forms:create") as any, createForm);
router.get("/", protect as any, blockSuspended as any, requirePermission("forms:read") as any, listForms);
router.get("/:formId/overview", protect as any, blockSuspended as any, requirePermission("forms:read", { resourceType: "form" }) as any, getFormOverview);
router.get("/:formId/events", protect as any, blockSuspended as any, requirePermission("forms:read", { resourceType: "form" }) as any, listFormEvents);
router.get("/:formId", protect as any, blockSuspended as any, requirePermission("forms:read", { resourceType: "form" }) as any, getForm);
router.put("/:formId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, updateForm);
router.patch("/:formId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, patchForm);
router.post("/:formId/move", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, moveForm);
router.patch("/:formId/move", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, moveForm);
router.delete("/:formId", protect as any, blockSuspended as any, requirePermission("forms:delete", { resourceType: "form" }) as any, deleteForm);
router.post("/:formId/duplicate", protect as any, blockSuspended as any, requirePermission("forms:create", { resourceType: "form" }) as any, duplicateForm);
router.post("/:formId/publish", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, publishForm);
// Sprint 13 (BE 0.3, 0.4, 0.8). Readiness is read-only (forms:read); changing what is public needs forms:publish;
// archiving is the same Owner/Admin tier; a test submission is an edit-tier action (forms:write).
router.get("/:formId/readiness", protect as any, blockSuspended as any, requirePermission("forms:read", { resourceType: "form" }) as any, getReadiness);
router.post("/:formId/unpublish", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, unpublishForm);
router.post("/:formId/regenerate-link", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, regenerateLink);
router.post("/:formId/archive", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, archiveForm);
router.post("/:formId/unarchive", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, unarchiveForm);
router.post("/:formId/test-submissions", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, createTestSubmission);

router.post("/:formId/close", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, closeForm);

// Per-form access panel routes (BE 0.6 / C2.7 / CF1.6)
router.get("/:formId/grants", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, listFormGrants);
router.post("/:formId/grants", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, createFormGrant);
router.delete("/:formId/grants/:userId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, revokeFormGrant);

router.post("/:formId/submissions", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "form" }) as any, submitForm);
router.get("/:formId/submissions", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "form" }) as any, getSubmissions);

// Score comparison (Sprint 12, BE 0.5 / B6.1)
router.get("/:formId/score-comparison", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "form" }) as any, getScoreComparison);

export default router;
