import { Router } from "express";
import { publicTemplatesRateLimiter } from "../middleware/rateLimiter";
import { getFormLooks } from "../controllers/formLooks.controller";

const router = Router();

// GET /api/form-looks - the ready-made Looks (no auth, rate-limited, cached)
router.get("/", publicTemplatesRateLimiter, getFormLooks);

export default router;
