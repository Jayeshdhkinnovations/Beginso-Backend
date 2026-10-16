import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { protect, blockSuspended } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { userActionRateLimiter } from "../middleware/rateLimiter";
import { uploadFile, getFile, getUploadDir, cleanEmptyDirs } from "../controllers/upload.controller";

const router = Router();

// Multer Storage Configuration
//
// Multer's `destination` callback fires as soon as it encounters the file part
// in the multipart stream — at that point `req.body.formId` is only reliably
// populated if the client happened to send the `formId` field BEFORE the file
// field. Since we can't control client field ordering, every upload is first
// staged into a per-request scratch directory here; `uploadFile` (which runs
// after Multer has finished parsing the entire request body) then moves it
// into the real `<userId>/<formId>/brand/...` location once `formId` is known
// for certain.
//
// The staging dir is also recorded on `req._stagingDirs` (not just on the
// eventual `file` object) because Multer doesn't always populate `req.file`/
// `req.files` when it aborts partway through writing a file (e.g. a
// LIMIT_FILE_SIZE error) — the error handler below needs a way to find and
// remove the partially-written staging directory even then.
const storage = multer.diskStorage({
  destination: (req: any, file, cb) => {
    const uploadDir = getUploadDir();
    const stagingDir = path.join(uploadDir, "_staging", crypto.randomBytes(16).toString("hex"));
    fs.mkdirSync(stagingDir, { recursive: true });
    req._stagingDirs = req._stagingDirs || [];
    req._stagingDirs.push(stagingDir);
    cb(null, stagingDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    // A random prefix keeps the original name readable but makes the stored path unique. Without it two uploads called
    // "logo.png" (or an avatar and a workspace logo) landed on the SAME file: the second silently replaced the first,
    // both Upload rows were charged for one file, and deleting one removed the other's image.
    cb(null, `${crypto.randomBytes(4).toString("hex")}-${safeName}`);
  },
});

// Configure Multer Upload Middleware to accept any fieldname (logo, cover, file, etc.)
const uploadAny = multer({
  storage,
  limits: {
    // Enforce the file-size limit before the file is fully written
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
}).any();

router.post("/", protect as any, blockSuspended as any, userActionRateLimiter("upload", 120) as any, requirePermission("uploads:create") as any, (req: any, res: any, _next: any) => {
  uploadAny(req, res, async (err: any) => {
    if (err) {
      // Clean up whatever staging directory this request created before failing.
      // (Multer doesn't reliably populate req.file/req.files on this path, so we
      // rely on req._stagingDirs recorded directly in the destination callback.)
      try {
        const uploadDir = getUploadDir();
        const stagingDirs: string[] = req._stagingDirs || [];
        for (const dir of stagingDirs) {
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
          await cleanEmptyDirs(path.dirname(dir), uploadDir);
        }
      } catch {
        // Ignore silently
      }

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            success: false,
            message: "File size limit exceeded. Maximum size is 5MB.",
          });
        }
        return res.status(400).json({
          success: false,
          message: err.message,
        });
      }
      return res.status(500).json({
        success: false,
        message: "An error occurred during file upload initialization.",
      });
    }

    // Since we used any(), let's map the first file to req.file for uploadFile controller compatibility
    if (req.files && req.files.length > 0) {
      req.file = req.files[0];
    }

    uploadFile(req, res);
  });
});

// Route to serve/stream the stored file for preview/download
router.get(/^\/file\/(.+)$/, getFile as any);

export default router;
