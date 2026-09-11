import { Router } from "express";
import {
  listInvitations,
  sendInvitation,
  resendInvitation,
  revokeInvitation,
  previewInvitation,
  acceptInvitation,
  declineInvitation,
} from "../controllers/invitation.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";

const router = Router({ mergeParams: true });

// BE 0.4: Public preview endpoint — requires NO authentication
router.get("/preview/:token", previewInvitation);
router.get("/token/:token", previewInvitation);

// BE 0.4: Accept & Decline endpoints
router.post("/:token/accept", protect as any, blockSuspended as any, acceptInvitation);
router.post("/accept/:token", protect as any, blockSuspended as any, acceptInvitation);
router.post("/:token/decline", declineInvitation);
router.post("/decline/:token", declineInvitation);

// BE 0.3: Workspace-level invitation management (list, send, resend, revoke)
router.get(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("team:read", { resourceType: "workspace" }) as any,
  listInvitations
);

router.post(
  "/",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  sendInvitation
);

router.post(
  "/:invitationId/resend",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  resendInvitation
);
router.post(
  "/:id/resend",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  resendInvitation
);
router.post(
  "/:token/resend",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  resendInvitation
);

router.post(
  "/:invitationId/revoke",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  revokeInvitation
);
router.post(
  "/:id/revoke",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  revokeInvitation
);
router.post(
  "/:token/revoke",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  revokeInvitation
);

router.delete(
  "/:invitationId",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  revokeInvitation
);
router.delete(
  "/:id",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  revokeInvitation
);
router.delete(
  "/:token",
  protect as any,
  blockSuspended as any,
  requirePermission("team:manage", { resourceType: "workspace" }) as any,
  revokeInvitation
);

// Fallback token preview for /:token when token is 32-64 hex chars
router.get("/:token", (req, res, next) => {
  // If it's not a known sub-route, treat as preview token
  previewInvitation(req, res, next);
});

export default router;
