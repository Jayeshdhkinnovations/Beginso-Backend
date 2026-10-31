import { Router } from "express";
import { deleteProfile } from "../controllers/user.controller";
import { getProfileMe, patchProfileMe, completeOnboarding } from "../controllers/user_settings.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";

const router = Router();

router.get("/me", protect as any, blockSuspended as any, getProfileMe);
router.patch("/me", protect as any, blockSuspended as any, patchProfileMe);
router.post("/me/onboarding-complete", protect as any, blockSuspended as any, completeOnboarding);
router.delete("/profile", protect as any, blockSuspended as any, deleteProfile);

export default router;
