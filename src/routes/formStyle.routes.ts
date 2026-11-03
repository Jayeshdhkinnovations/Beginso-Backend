import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { listFormStyles, createFormStyle, renameFormStyle, removeFormStyle } from "../controllers/formStyle.controller";

const router = Router();

// Reading the saved styles needs forms:read; saving, renaming or removing needs forms:write (the controller also checks who saved it).
router.get("/", protect as any, blockSuspended as any, requirePermission("forms:read") as any, listFormStyles);
router.post("/", protect as any, blockSuspended as any, requirePermission("forms:write") as any, createFormStyle);
router.patch("/:id", protect as any, blockSuspended as any, requirePermission("forms:write") as any, renameFormStyle);
router.delete("/:id", protect as any, blockSuspended as any, requirePermission("forms:write") as any, removeFormStyle);

export default router;
