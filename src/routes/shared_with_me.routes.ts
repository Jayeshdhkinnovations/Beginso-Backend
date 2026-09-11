import { Router } from "express";
import { getSharedWithMe } from "../controllers/shared_with_me.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";

const router = Router();

// BE 0.7: GET /api/shared-with-me
router.get("/", protect as any, blockSuspended as any, getSharedWithMe);

export default router;
