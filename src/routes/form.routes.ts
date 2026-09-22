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
} from "../controllers/form.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

import { listFormEvents } from "../controllers/event.controller";

const router = Router();

router.post("/", protect as any, blockSuspended as any, requirePermission("forms:create") as any, createForm);
router.get("/", protect as any, blockSuspended as any, requirePermission("forms:read") as any, listForms);
router.get("/:formId/events", protect as any, blockSuspended as any, requirePermission("forms:read", { resourceType: "form" }) as any, listFormEvents);
router.get("/:formId", protect as any, blockSuspended as any, requirePermission("forms:read", { resourceType: "form" }) as any, getForm);
router.put("/:formId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, updateForm);
router.patch("/:formId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, patchForm);
router.post("/:formId/move", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, moveForm);
router.patch("/:formId/move", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, moveForm);
router.delete("/:formId", protect as any, blockSuspended as any, requirePermission("forms:delete", { resourceType: "form" }) as any, deleteForm);
router.post("/:formId/duplicate", protect as any, blockSuspended as any, requirePermission("forms:create", { resourceType: "form" }) as any, duplicateForm);
router.post("/:formId/publish", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, publishForm);
router.post("/:formId/close", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, closeForm);

// Per-form access panel routes (BE 0.6 / C2.7 / CF1.6)
router.get("/:formId/grants", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, listFormGrants);
router.post("/:formId/grants", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, createFormGrant);
router.delete("/:formId/grants/:userId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, revokeFormGrant);

router.post("/:formId/submissions", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "form" }) as any, submitForm);
router.get("/:formId/submissions", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "form" }) as any, getSubmissions);

export default router;
