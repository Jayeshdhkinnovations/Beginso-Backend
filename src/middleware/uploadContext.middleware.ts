import { Request, Response, NextFunction } from "express";
import { FormService } from "../services/form.service";
import Workspace from "../models/Workspace";
import mongoose from "mongoose";

export const prepareUploadContext = async (req: any, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;
    
    // Only a published, open form may receive files. This runs BEFORE Multer, so a draft, closed,
    // expired or full form (or a made-up slug) never gets a single byte written to disk.
    let form: any;
    try {
      form = await new FormService().getPublicFormBySlug(slug as string);
    } catch {
      res.status(404).json({ success: false, message: "Form not found" });
      return;
    }

    const workspace = form.workspaceId ? await Workspace.findById(form.workspaceId).select("owner").lean() : null;
    const userId = workspace?.owner?.toString() || form.createdBy?.toString() || "unknown-user";
    const formId = form._id.toString();
    const responseId = new mongoose.Types.ObjectId().toString(); // Pre-generate Response ID

    // Attach to the request object so Multer can read it
    req.uploadContext = {
      userId,
      formId,
      responseId,
    };

    next();
  } catch (error) {
    console.error("prepareUploadContext error:", error);
    next(error);
  }
};
