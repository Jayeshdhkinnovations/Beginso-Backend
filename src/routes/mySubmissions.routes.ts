import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { getMySubmissions, getMySubmission, patchMySubmission } from "../controllers/respond.controller";

const router = Router();

// Sprint 13 (A5.1). A signed-in respondent's own submissions. There is deliberately NO requirePermission
// and no workspace scoping: a respondent is not a workspace member. The only check is ownership
// (respondent.service.ts: someone else's id is simply "not found").
router.get("/", protect as any, blockSuspended as any, getMySubmissions);
router.get("/:id", protect as any, blockSuspended as any, getMySubmission);
router.patch("/:id", protect as any, blockSuspended as any, patchMySubmission);

export default router;
