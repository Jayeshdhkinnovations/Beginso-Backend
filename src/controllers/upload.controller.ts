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

export const getFile = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const filename = req.params.filename || (req.params as any)[0];

    if (!filename || typeof filename !== "string") {
      res.status(400).json({
        success: false,
        message: "Filename is required and must be a string",
      });
      return;
    }

    // Explicitly reject path traversal attempts
    if (filename.includes("..")) {
      res.status(400).json({
        success: false,
        message: "Invalid file path",
      });
      return;
    }

    // Stable stored filename/path (avoid collisions and path traversal)
    // Extract only base name to prevent traversal attacks
    const safeFilename = path.basename(filename);
    const uploadDir = getUploadDir();
    const normalizedPath = filename.replace(/[\/\\]/g, path.sep);
    const forwardSlashPath = filename.replace(/[\/\\]/g, "/");

    // Query DB first to find its relative path
    const uploadDoc = await Upload.findOne({
      $or: [
        { path: normalizedPath },
        { path: forwardSlashPath },
        { path: safeFilename },
        { path: { $regex: safeFilename + "$" } }
      ]
    });

    let targetPath = uploadDoc ? uploadDoc.path : normalizedPath;
    let filePath = path.resolve(uploadDir, targetPath);

    if (!fs.existsSync(filePath)) {
      targetPath = safeFilename;
      filePath = path.resolve(uploadDir, targetPath);
    }

    // Double check that the resolved path is indeed inside the upload directory
    if (!filePath.startsWith(path.resolve(uploadDir))) {
      res.status(400).json({
        success: false,
        message: "Invalid file path",
      });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({
        success: false,
        message: "File not found",
      });
      return;
    }

    // If it's a private file (not branding), check authentication
    if (!uploadDoc || !uploadDoc.isBranding) {
      let token: string | undefined;

      // 1. Check Authorization Header (case-insensitive)
      const authHeader = req.headers.authorization || (req.headers as any).Authorization;
      if (authHeader && typeof authHeader === "string") {
        const parts = authHeader.trim().split(" ");
        if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
          token = parts[1];
        } else if (parts.length === 1) {
          token = parts[0];
        }
      }

      // 2. Check Query Parameters (?token=... or ?access_token=...)
      if (!token && req.query) {
        if (typeof req.query.token === "string") {
          token = req.query.token;
        } else if (typeof req.query.access_token === "string") {
          token = req.query.access_token;
        } else if (typeof req.query.auth === "string") {
          token = req.query.auth;
        }
      }

      // 3. Check Custom Header
      if (!token && req.headers["x-access-token"] && typeof req.headers["x-access-token"] === "string") {
        token = req.headers["x-access-token"];
      }

      // 4. Check Cookies
      if (!token && req.headers.cookie) {
        const cookies = req.headers.cookie.split(";").reduce((acc, c) => {
          const [name, ...val] = c.trim().split("=");
          acc[name] = val.join("=");
          return acc;
        }, {} as Record<string, string>);
        token = cookies.token || cookies.jwt || cookies.access_token;
      }

      if (!token || token === "undefined" || token === "null") {
        res.status(401).json({
          success: false,
          message: "Unauthorized access to private files",
          error: { message: "Unauthorized access to private files" },
        });
        return;
      }

      try {
        const decoded = jwt.verify(
          token,
          process.env.JWT_SECRET as string
        ) as { id: string; email: string; role: string };

        const user = await User.findById(decoded.id);
        if (!user) {
          res.status(401).json({
            success: false,
            message: "Unauthorized: Invalid user session",
            error: { message: "Unauthorized: Invalid user session" },
          });
          return;
        }

        // Workspace authorization check for private files with owner metadata
        const userId = user._id.toString();
        let userWorkspaceId = user.workspaceId
          ? (user.workspaceId._id ? user.workspaceId._id.toString() : user.workspaceId.toString())
          : "";
        
        if (!userWorkspaceId) {
          const userWs = await Workspace.findOne({ owner: userId });
          if (userWs) userWorkspaceId = userWs._id.toString();
        }

        let isAuthorized = user.role === "super_admin";

        const isResponseFile = !!forwardSlashPath.match(/(?:^|\/)responses\//);

        if (!isAuthorized && uploadDoc && uploadDoc.owner) {
          const ownerId = uploadDoc.owner.toString();
          if (userId === ownerId) {
            isAuthorized = true;
          }

          if (!isAuthorized && !isResponseFile && userWorkspaceId) {
            const ownerWs = await Workspace.findOne({ owner: ownerId });
            const ownerWsId = ownerWs ? ownerWs._id.toString() : "";
            if (ownerWsId && userWorkspaceId === ownerWsId) {
              isAuthorized = true;
            }
          }

          if (!isAuthorized && !isResponseFile) {
            const workspace = await Workspace.findOne({
              $or: [
                { owner: ownerId, "members.user": userId },
                { owner: userId, "members.user": ownerId },
              ],
            });
            if (workspace) {
              isAuthorized = true;
            }
          }
        }

        // Additional path-based resolution and per-form access grant check (BE 0.6 / R3)
        if (!isAuthorized) {
          let targetFormId: string | null = null;
          const responseIdMatch = forwardSlashPath.match(/(?:^|\/)responses\/([0-9a-fA-F]{24})(?:\/|$)/);
          if (responseIdMatch && responseIdMatch[1]) {
            const responseDoc = await ResponseModel.findById(responseIdMatch[1]);
            if (responseDoc && responseDoc.formId) {
              targetFormId = responseDoc.formId.toString();
            }
          }

          if (!targetFormId) {
            const formIdMatch = forwardSlashPath.match(/(?:^|\/)([0-9a-fA-F]{24})(?:\/|$)/);
            if (formIdMatch && formIdMatch[1]) {
              const formDoc = await Form.findById(formIdMatch[1]);
              if (formDoc) {
                targetFormId = formDoc._id.toString();
              }
            }
          }

          if (targetFormId) {
            const formDoc = await Form.findById(targetFormId);
            if (formDoc) {
              // 1. Workspace membership or ownership check
              if (formDoc.workspaceId) {
                const isOwner = userWorkspaceId && formDoc.workspaceId.toString() === userWorkspaceId;
                const membership = await Membership.findOne({
                  workspaceId: formDoc.workspaceId,
                  userId: user._id,
                });
                if (isOwner || membership) {
                  isAuthorized = true;
                }
              } else if (formDoc.createdBy && formDoc.createdBy.toString() === userId) {
                isAuthorized = true;
              }

              // 2. Per-form grant check (works on personal and workspace forms)
              if (!isAuthorized) {
                const grant = await FormAccessGrant.findOne({
                  formId: formDoc._id,
                  userId: user._id,
                });
                if (grant) {
                  isAuthorized = true;
                }
              }
            }
          }
        }

        if (!isAuthorized) {
          res.status(403).json({
            success: false,
            message: "Forbidden: You do not have permission to access this file",
            error: { message: "Forbidden: You do not have permission to access this file" },
          });
          return;
        }
      } catch (err) {
        res.status(401).json({
          success: false,
          message: "Unauthorized: Invalid or expired token",
          error: { message: "Unauthorized: Invalid or expired token" },
        });
        return;
      }
    }

    // Serve/stream the stored file for preview/download
    res.sendFile(filePath);
  } catch (error: any) {
    console.error("Error serving file:", error);
    res.status(500).json({
      success: false,
      message: "Error serving file",
      error: error.message,
    });
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
