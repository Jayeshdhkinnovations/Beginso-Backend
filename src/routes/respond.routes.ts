import { Router } from "express";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { respondLinkRateLimiter, respondResendRateLimiter, emailTargetRateLimiter } from "../middleware/rateLimiter";
import {
  getRespondLink,
  patchRespondLink,
  claimRespondLink,
  resendRespondLink,
} from "../controllers/respond.controller";

const router = Router();

// Sprint 13 (A5.3 / A5.4). Token-authenticated: no session, no requirePermission - the token IS the
// credential and it is scoped to exactly one response (respondent.service.ts). Mounted at /api/respond.
//
// `resend` is declared first so "resend" is never swallowed as a :token.
router.post("/resend", respondResendChain());
router.get("/:token", respondLinkRateLimiter, getRespondLink);
router.patch("/:token", respondLinkRateLimiter, patchRespondLink);
// Claiming is the one call that needs a real session: the respondent has just created their account
// from the link, and the account's email must match the address the link was sent to.
router.post("/:token/claim", respondLinkRateLimiter, protect as any, blockSuspended as any, claimRespondLink);

function respondResendChain() {
  // per IP, and per target address so one caller cannot flood somebody's inbox.
  return [respondResendRateLimiter, emailTargetRateLimiter, resendRespondLink] as any;
}

export default router;
