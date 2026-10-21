import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { userActionRateLimiter } from "../middleware/rateLimiter";
import { putMyResponseView, deleteMyResponseView } from "../controllers/responseView.controller";

const router = Router();

// The layout switcher saves on every change (debounced client-side), so this is generous but still capped per user.
const writeLimit = userActionRateLimiter("response-view", 60, 60 * 1000);

router.put("/response-view", protect as any, blockSuspended as any, writeLimit, putMyResponseView);
router.delete("/response-view", protect as any, blockSuspended as any, writeLimit, deleteMyResponseView);

export default router;
