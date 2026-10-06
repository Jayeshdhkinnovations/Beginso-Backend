import { Router } from "express";
import { getNotifications, getUnreadCount, markAllRead, markNotificationRead } from "../controllers/notification.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";

const router = Router();

router.get("/", protect as any, blockSuspended as any, getNotifications);
router.get("/unread-count", protect as any, blockSuspended as any, getUnreadCount);
router.post("/read-all", protect as any, blockSuspended as any, markAllRead);
router.post("/:id/read", protect as any, blockSuspended as any, markNotificationRead);
router.patch("/:id/read", protect as any, blockSuspended as any, markNotificationRead);

export default router;
