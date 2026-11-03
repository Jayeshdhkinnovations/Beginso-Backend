import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { unsplashRateLimiter } from "../middleware/rateLimiter";
import { search, featured, download } from "../controllers/unsplash.controller";

const router = Router();

// Choosing a photo for a form is editing the form, so it needs forms:write; each person is also limited, to spare the shared Unsplash allowance.
router.get("/search", protect as any, blockSuspended as any, requirePermission("forms:write") as any, unsplashRateLimiter, search);
router.get("/featured", protect as any, blockSuspended as any, requirePermission("forms:write") as any, unsplashRateLimiter, featured);
router.post("/download", protect as any, blockSuspended as any, requirePermission("forms:write") as any, unsplashRateLimiter, download);

export default router;
