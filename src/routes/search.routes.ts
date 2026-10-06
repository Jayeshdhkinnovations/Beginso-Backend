import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { searchRateLimiter } from "../middleware/rateLimiter";
import { search } from "../controllers/search.controller";

const router = Router();

// Sprint 14 (B2). No requirePermission here on purpose: the context (workspace or personal) is resolved and the
// caller's membership verified inside the handler (utils/contextScope.ts), then visibility is applied per group.
router.get("/", protect as any, blockSuspended as any, searchRateLimiter, search);

export default router;
