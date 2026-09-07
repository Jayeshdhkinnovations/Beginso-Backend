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
} from "../controllers/form.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

const router = Router();

router.post("/", protect as any, blockSuspended as any, requirePermission("forms:create") as any, createForm);
router.get("/", protect as any, blockSuspended as any, requirePermission("forms:read") as any, listForms);
router.get("/:formId", protect as any, blockSuspended as any, requirePermission("forms:read", { resourceType: "form" }) as any, getForm);
router.put("/:formId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, updateForm);
router.patch("/:formId", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, patchForm);
router.post("/:formId/move", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, moveForm);
router.patch("/:formId/move", protect as any, blockSuspended as any, requirePermission("forms:write", { resourceType: "form" }) as any, moveForm);
router.delete("/:formId", protect as any, blockSuspended as any, requirePermission("forms:delete", { resourceType: "form" }) as any, deleteForm);
router.post("/:formId/duplicate", protect as any, blockSuspended as any, requirePermission("forms:create", { resourceType: "form" }) as any, duplicateForm);
router.post("/:formId/publish", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, publishForm);
router.post("/:formId/close", protect as any, blockSuspended as any, requirePermission("forms:publish", { resourceType: "form" }) as any, closeForm);

router.post("/:formId/submissions", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "form" }) as any, submitForm);
router.get("/:formId/submissions", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "form" }) as any, getSubmissions);

export default router;
