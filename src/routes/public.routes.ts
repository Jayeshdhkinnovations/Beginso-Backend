import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { getPublicFormBySlug, submitPublicForm, recordFormView, issueFormSubmitTicket } from "../controllers/form.controller";
import { unsubscribeFromEmails } from "../controllers/notification.controller";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { getUploadDir } from "../controllers/upload.controller";
import { submitRateLimiter, publicFormReadLimiter, authRateLimiter } from "../middleware/rateLimiter";
import { MAX_UPLOAD_MB, MAX_UPLOAD_FILES, MAX_ANSWERS_BYTES } from "../utils/uploadLimits";
import { prepareUploadContext } from "../middleware/uploadContext.middleware";

const router = Router();
// Multer Storage Configuration for Public Form Submissions
const storage = multer.diskStorage({
  destination: (req: any, file, cb) => {
    const uploadDir = getUploadDir();
    const ctx = req.uploadContext || { userId: "unknown", formId: "unknown", responseId: "unknown" };
    const targetDir = path.join(uploadDir, ctx.userId, ctx.formId, "responses", ctx.responseId);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, safeName);
  },
});

// Limits are read when a request arrives so MAX_UPLOAD_* can be tuned without a rebuild. They apply
// before anything is stored: an oversized or over-numerous submission is refused by Multer (400).
const uploadAny = (req: any, res: any, next: any) =>
  multer({
    storage,
    limits: {
      fileSize: MAX_UPLOAD_MB() * 1024 * 1024,
      files: MAX_UPLOAD_FILES(),
      fields: 200,
      fieldSize: MAX_ANSWERS_BYTES(),
      parts: MAX_UPLOAD_FILES() + 200,
    },
  }).any()(req, res, next);

// Sprint 14 (B4.2): signed, expiring, no session. Two path segments deep, so it never collides with `/:slug`.
router.get("/notifications/unsubscribe/:token", authRateLimiter, unsubscribeFromEmails);
router.get("/:slug", publicFormReadLimiter, getPublicFormBySlug);
router.post("/:slug/view", publicFormReadLimiter, recordFormView);
// Sprint 13 (Mode 3, OQ-10): a signed-in respondent asks for a one-shot ticket, then submits directly.
router.post("/:slug/submit-ticket", publicFormReadLimiter, protect as any, blockSuspended as any, issueFormSubmitTicket);
router.post("/:slug/submit", submitRateLimiter, prepareUploadContext as any, uploadAny, submitPublicForm);

export default router;
