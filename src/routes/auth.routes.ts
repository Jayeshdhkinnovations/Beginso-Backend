import { Router } from "express";
import {
  getMe,
  session,
  logout,
  requestEmailVerification,
  revealEmailCode,
  verifyEmailCode,
  requestForgotPassword,
  confirmPasswordReset,
  notifyPasswordChanged,
} from "../controllers/auth.controller";
import { getSessions, revokeSession, revokeOtherSessions } from "../controllers/session.controller";
import { protect, optionalProtect, blockSuspended } from "../middleware/auth.middleware";
import { authRateLimiter, emailTargetRateLimiter } from "../middleware/rateLimiter";
import { requirePermission } from "../middleware/permission.middleware";

const router = Router();

router.post("/session", authRateLimiter, session);
router.post("/email-verification", authRateLimiter, requestEmailVerification);
router.post("/email-verification/reveal", authRateLimiter, revealEmailCode);
router.post("/email-verification/verify", authRateLimiter, verifyEmailCode);
router.post("/forgot-password", authRateLimiter, emailTargetRateLimiter, requestForgotPassword);
router.post("/confirm-password-reset", authRateLimiter, emailTargetRateLimiter, confirmPasswordReset);
router.post("/password-changed", authRateLimiter, emailTargetRateLimiter, optionalProtect as any, notifyPasswordChanged);
router.post("/logout", protect as any, blockSuspended as any, logout);
router.get("/me", protect as any, blockSuspended as any, getMe);
router.get("/sessions", protect as any, blockSuspended as any, requirePermission("sessions:read") as any, getSessions);
router.delete("/sessions", protect as any, blockSuspended as any, requirePermission("sessions:manage") as any, revokeOtherSessions);
router.delete("/sessions/:id", protect as any, blockSuspended as any, requirePermission("sessions:manage", { resourceType: "session" }) as any, revokeSession);

export default router;