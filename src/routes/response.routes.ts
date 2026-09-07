import { Router } from "express";
import {
  getResponses,
  getResponseStats,
  getResponseDetail,
  updateResponseStatus,
  deleteResponse,
  getResponseFileUrl,
} from "../controllers/response.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

const router = Router();

// Scope all response routes with authentication and suspension checks
router.get("/", protect as any, blockSuspended as any, requirePermission("responses:read") as any, getResponses);
router.get("/stats", protect as any, blockSuspended as any, requirePermission("responses:read") as any, getResponseStats);
router.get("/:id", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, getResponseDetail);
router.patch("/:id", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, updateResponseStatus);
router.put("/:id", protect as any, blockSuspended as any, requirePermission("responses:write", { resourceType: "response" }) as any, updateResponseStatus);
router.delete("/:id", protect as any, blockSuspended as any, requirePermission("responses:delete", { resourceType: "response" }) as any, deleteResponse);
router.get("/:id/file/:fileId", protect as any, blockSuspended as any, requirePermission("responses:read", { resourceType: "response" }) as any, getResponseFileUrl);

export default router;
