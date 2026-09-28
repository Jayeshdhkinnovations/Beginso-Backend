import { Response } from "express";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { AuthenticatedRequest } from "../middleware/auth.middleware";
import Upload from "../models/Upload";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import FormAccessGrant from "../models/FormAccessGrant";
import Membership from "../models/Membership";
import SessionModel from "../models/Session";
import { hasPermission } from "../middleware/permission.middleware";
import mongoose from "mongoose";
import { UploadResponse } from "../types/upload";

// ponytail: This implementation utilizes local disk storage for keeping uploaded assets.
// This introduces a local-disk storage ceiling, has no CDN caching, and creates issues
// if we scale to multi-server stateless architectures.
// The upgrade path is to migrate to cloud object storage (like AWS S3 or Cloudflare R2) in the future.
export const getUploadDir = (): string => {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
};

export const uploadFile = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const file = req.file;

  if (!file) {
    res.status(400).json({
      success: false,
      message: "No file uploaded",
    });
    return;
  }

  try {
    // Restrict branding uploads (logo/cover) to image MIME types
    const isBranding =
      file.fieldname === "logo" ||
      file.fieldname === "cover" ||
      req.body.type === "branding" ||
      req.body.uploadType === "branding" ||
      req.query.type === "branding" ||
      file.mimetype.startsWith("image/");

    if (isBranding && !file.mimetype.startsWith("image/")) {
      if (file && file.path && fs.existsSync(file.path)) {
        await deleteFileAndEmptyParents(file.path, getUploadDir());
      }
      res.status(400).json({
        success: false,
        message: "Branding uploads (logo/cover) must be image files",
      });
      return;
    }

    if (!req.user || !req.user._id) {
      if (file && file.path && fs.existsSync(file.path)) {
        await deleteFileAndEmptyParents(file.path, getUploadDir());
      }
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
      return;
    }

    const formId = req.query.formId || req.body.formId;
    if (formId !== undefined && (typeof formId !== "string" || !mongoose.Types.ObjectId.isValid(formId))) {
      if (file.path && fs.existsSync(file.path)) {
        await deleteFileAndEmptyParents(file.path, getUploadDir());
      }
      res.status(400).json({ success: false, message: "formId must be a valid id" });
      return;
    }
    const isBanner =
      file.fieldname === "cover" ||
      file.fieldname === "banner" ||
      file.fieldname === "brand_banner" ||
      file.fieldname === "brandBanner" ||
      req.query.type === "cover" ||
      req.body.type === "cover" ||
      req.query.type === "banner" ||
      req.body.type === "banner" ||
      req.query.type === "brand_banner" ||
      req.body.type === "brand_banner";

    const subfolder = isBanner
      ? path.join("brand", "brand_banner")
      : path.join("brand", "brand_logo");

    const userId = req.user._id.toString();
    const relativePath = formId
      ? path.join(userId, String(formId), subfolder, file.filename)
      : path.join(userId, subfolder, file.filename);

    // Multer staged the file into a scratch directory (see upload.routes.ts) since
    // `formId` isn't reliably known until the full request body has been parsed.
    // Now that it is, move the file into its real, structured resting place.
    const uploadDir = getUploadDir();
    const finalPath = path.join(uploadDir, relativePath);
    if (!path.resolve(finalPath).startsWith(path.resolve(uploadDir) + path.sep)) {
      if (file.path && fs.existsSync(file.path)) {
        await deleteFileAndEmptyParents(file.path, uploadDir);
      }
      res.status(400).json({ success: false, message: "Invalid upload path" });
      return;
    }
    const finalDir = path.dirname(finalPath);
    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }
    fs.renameSync(file.path, finalPath);
    await cleanEmptyDirs(path.dirname(file.path), uploadDir);
    file.path = finalPath;

    // Persist file metadata in MongoDB: name, size, type, path (structured path), owner, upload time
    const uploadDoc = await Upload.create({
      name: file.originalname,
      size: file.size,
      type: file.mimetype,
      path: relativePath,
      owner: req.user._id,
      uploadTime: new Date(),
      isBranding,
    });

    const urlPath = relativePath.replace(/\\/g, "/");
    const fileUrl = `${req.protocol}://${req.get("host")}/api/upload/file/${urlPath}`;

    const response: UploadResponse = {
      success: true,
      message: "File uploaded successfully",
      url: fileUrl,
      metadata: {
        id: uploadDoc._id.toString(),
        name: uploadDoc.name,
        size: uploadDoc.size,
        type: uploadDoc.type,
        path: uploadDoc.path,
        owner: uploadDoc.owner.toString(),
        uploadTime: uploadDoc.uploadTime.toISOString(),
        isBranding: uploadDoc.isBranding,
      },
    };

    res.status(201).json(response);
  } catch (error: any) {
    // clean up the temp write on failure
    if (file && file.path && fs.existsSync(file.path)) {
      try {
        await deleteFileAndEmptyParents(file.path, getUploadDir());
      } catch (err) {
        console.error("Failed to delete temp file:", err);
      }
    }



    console.error("Error in uploadFile:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred during file upload",
      error: error.message,
    });
  }
};

const SAFE_INLINE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);

// Uploads are user-controlled content served from the API origin. A browser must never treat one
// as a page: sandbox + nosniff, and only known-safe types may render inline.
const setFileResponseHeaders = (res: Response, filePath: string): void => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (!SAFE_INLINE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath).replace(/["\r\n]/g, "")}"`);
  }
};

// Authorization for a private upload is decided from the STORED file (its response and form),
// never from the URL the caller typed. Same rules as reading the response itself (R3).
const canReadUpload = async (user: any, uploadDoc: any): Promise<boolean> => {
  if (user.role === "super_admin") return true;

  const storedPath = String(uploadDoc.path).replace(/\\/g, "/");
  const responseId = storedPath.match(/(?:^|\/)responses\/([0-9a-fA-F]{24})(?:\/|$)/)?.[1];
  if (!responseId) {
    return uploadDoc.owner?.toString() === user._id.toString();
  }

  const response = await ResponseModel.findById(responseId).select("formId").lean();
  const form = response ? await Form.findById(response.formId).select("workspaceId createdBy").lean() : null;
  if (!form) return false;

  const grant = await FormAccessGrant.findOne({ formId: form._id, userId: user._id }).lean();
  if (grant) return hasPermission(grant.role, "responses:read");

  if (form.workspaceId) {
    const membership = await Membership.findOne({ userId: user._id, workspaceId: form.workspaceId }).select("role").lean();
    if (membership) return hasPermission(membership.role, "responses:read");
    const ws = await Workspace.findById(form.workspaceId).select("owner").lean();
    return ws?.owner?.toString() === user._id.toString();
  }
  return form.createdBy?.toString() === user._id.toString();
};

const getSessionToken = (req: AuthenticatedRequest): string | undefined => {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === "string") {
    const parts = authHeader.trim().split(" ");
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) return parts[1];
    if (parts.length === 1) return parts[0];
  }
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(";").reduce((acc, c) => {
      const [name, ...val] = c.trim().split("=");
      acc[name] = val.join("=");
      return acc;
    }, {} as Record<string, string>);
    return cookies.token || cookies.jwt || cookies.access_token;
  }
  return undefined;
};

export const getFile = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const filename = req.params.filename || (req.params as any)[0];

    if (!filename || typeof filename !== "string") {
      res.status(400).json({ success: false, message: "Filename is required and must be a string" });
      return;
    }

    // Explicitly reject path traversal attempts
    if (filename.includes("..")) {
      res.status(400).json({ success: false, message: "Invalid file path" });
      return;
    }

    // Exact match on the stored path only (no regex, no basename fallback): the file that is
    // served is always the file that is authorized below.
    const forwardSlashPath = filename.replace(/[\/\\]/g, "/");
    const uploadDoc = await Upload.findOne({
      path: { $in: [forwardSlashPath, forwardSlashPath.replace(/\//g, path.sep), forwardSlashPath.replace(/\//g, "\\")] },
    });
    if (!uploadDoc) {
      res.status(404).json({ success: false, message: "File not found" });
      return;
    }

    const uploadDir = path.resolve(getUploadDir());
    const filePath = path.resolve(uploadDir, uploadDoc.path);
    if (!filePath.startsWith(uploadDir + path.sep)) {
      res.status(400).json({ success: false, message: "Invalid file path" });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: "File not found" });
      return;
    }

    // Branding images (logos, covers) are public; everything else needs a valid session.
    if (!uploadDoc.isBranding) {
      const token = getSessionToken(req);
      if (!token || token === "undefined" || token === "null") {
        res.status(401).json({
          success: false,
          message: "Unauthorized access to private files",
          error: { message: "Unauthorized access to private files" },
        });
        return;
      }

      let user: any;
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { id: string; sessionId?: string };
        if (decoded.sessionId) {
          const session = await SessionModel.findById(decoded.sessionId);
          if (!session || session.revokedAt) throw new Error("session revoked");
        }
        user = await User.findById(decoded.id);
        if (!user) throw new Error("no user");
      } catch {
        res.status(401).json({
          success: false,
          message: "Unauthorized: Invalid or expired token",
          error: { message: "Unauthorized: Invalid or expired token" },
        });
        return;
      }

      if (user.status === "suspended") {
        res.status(403).json({ success: false, message: "Account suspended", error: { code: "ACCOUNT_SUSPENDED", message: "Account suspended" } });
        return;
      }

      if (!(await canReadUpload(user, uploadDoc))) {
        res.status(403).json({
          success: false,
          message: "Forbidden: You do not have permission to access this file",
          error: { message: "Forbidden: You do not have permission to access this file" },
        });
        return;
      }
    }

    setFileResponseHeaders(res, filePath);
    res.sendFile(filePath);
  } catch (error: any) {
    console.error("Error serving file:", error);
    res.status(500).json({ success: false, message: "Error serving file" });
  }
};

export const cleanEmptyDirs = async (dir: string, stopDir: string) => {
  try {
    let currentDir = path.resolve(dir);
    const resolvedStopDir = path.resolve(stopDir);
    while (
      currentDir.toLowerCase() !== resolvedStopDir.toLowerCase() &&
      currentDir.toLowerCase().startsWith(resolvedStopDir.toLowerCase())
    ) {
      if (fs.existsSync(currentDir)) {
        const files = await fs.promises.readdir(currentDir);
        if (files.length === 0) {
          await fs.promises.rmdir(currentDir);
          currentDir = path.dirname(currentDir);
        } else {
          break;
        }
      } else {
        currentDir = path.dirname(currentDir);
      }
    }
  } catch (err) {
    // Ignore cleanup errors silently
  }
};

export const deleteFileAndEmptyParents = async (filePath: string, stopDir: string) => {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    await cleanEmptyDirs(path.dirname(filePath), stopDir);
  } catch (err) {
    console.error("Error during file/directory cleanup:", err);
  }
};
