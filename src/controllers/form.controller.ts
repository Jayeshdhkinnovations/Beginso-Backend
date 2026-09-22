import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { FormService } from "../services/form.service";
import { createFormSchema, patchFormSchema } from "../validations/form.validator";
import mongoose from "mongoose";
import Form from "../models/Form";
import Membership from "../models/Membership";
import FormAccessGrant from "../models/FormAccessGrant";
import User from "../models/User";
import { hasPermission } from "../middleware/permission.middleware";
import { SystemLog } from "../models/SystemLog";
import Workspace from "../models/Workspace";
import Upload from "../models/Upload";
import Notification from "../models/Notification";
import path from "path";
import fs from "fs";
import { getUploadDir } from "./upload.controller";
import { getRealClientIp, hashIp } from "../utils/ip";
import { logWorkspaceEvent } from "../services/event.service";

const formService = new FormService();

const getWorkspaceIdFromUser = async (user: any): Promise<string> => {
  if (user.workspaceId) {
    return user.workspaceId._id ? user.workspaceId._id.toString() : user.workspaceId.toString();
  }
  const membership = await Membership.findOne({ userId: user._id }).select("workspaceId").lean();
  if (membership && membership.workspaceId) {
    return membership.workspaceId.toString();
  }
  const workspace = await Workspace.findOne({ owner: user._id });
  return workspace ? workspace._id.toString() : "";
};

const resolveFormAccess = async (
  formId: string,
  user: any,
  formAccessGrant?: any
): Promise<{ formDoc: any; workspaceId: string; isAuthorized: boolean }> => {
  if (!formId || !mongoose.Types.ObjectId.isValid(formId)) {
    return { formDoc: null, workspaceId: "", isAuthorized: false };
  }
  const formDoc = await Form.findById(formId);
  if (!formDoc) {
    return { formDoc: null, workspaceId: "", isAuthorized: false };
  }

  // 1. Super admin platform bypass
  if (user.role === "super_admin") {
    return { formDoc, workspaceId: formDoc.workspaceId ? formDoc.workspaceId.toString() : "", isAuthorized: true };
  }

  // 2. Direct per-form grant
  if (formAccessGrant || (await FormAccessGrant.findOne({ formId: formDoc._id, userId: user._id }))) {
    return { formDoc, workspaceId: formDoc.workspaceId ? formDoc.workspaceId.toString() : "", isAuthorized: true };
  }

  // 3. Personal form or form created by the user
  if (formDoc.createdBy?.toString() === user._id.toString()) {
    return { formDoc, workspaceId: formDoc.workspaceId ? formDoc.workspaceId.toString() : "", isAuthorized: true };
  }

  // 4. Workspace membership / ownership check
  if (formDoc.workspaceId) {
    const wsId = formDoc.workspaceId.toString();
    const membership = await Membership.findOne({ userId: user._id, workspaceId: wsId });
    const ws = await Workspace.findById(wsId).select("owner");
    const isOwner = ws?.owner?.toString() === user._id.toString();
    if (membership || isOwner) {
      return { formDoc, workspaceId: wsId, isAuthorized: true };
    }
  }

  return { formDoc, workspaceId: formDoc.workspaceId ? formDoc.workspaceId.toString() : "", isAuthorized: false };
};

export const createForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    // Step 1: Validate payload using Zod
    const validatedData = createFormSchema.parse(req.body);

    // Step 2: Determine target destination workspace (BE 0.4)
    const explicitDestination =
      req.body?.destinationWorkspaceId !== undefined
        ? req.body.destinationWorkspaceId
        : req.body?.workspaceId !== undefined
        ? req.body.workspaceId
        : req.headers["x-workspace-id"] !== undefined
        ? req.headers["x-workspace-id"]
        : req.query?.workspaceId;

    let resolvedWorkspaceId: string | null = null;

    if (explicitDestination !== undefined && explicitDestination !== null && explicitDestination !== "") {
      const destStr = Array.isArray(explicitDestination) ? explicitDestination[0] : String(explicitDestination).trim();

      if (destStr === "personal" || destStr === "null") {
        resolvedWorkspaceId = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(destStr)) {
          res.status(400).json({
            success: false,
            message: "Invalid workspaceId format",
            error: { message: "Invalid workspaceId format" },
          });
          return;
        }

        const targetWs = await Workspace.findById(destStr);
        if (!targetWs) {
          res.status(404).json({
            success: false,
            message: "Workspace not found",
            error: { message: "Workspace not found" },
          });
          return;
        }

        if (targetWs.status === "suspended") {
          res.status(403).json({
            success: false,
            message: "Workspace is suspended",
            error: { message: "Workspace is suspended" },
          });
          return;
        }

        if (authReq.user.role !== "super_admin") {
          const membership = await Membership.findOne({
            userId: authReq.user._id,
            workspaceId: targetWs._id,
          });
          const isOwner = targetWs.owner.toString() === authReq.user._id.toString();
          const role = membership ? membership.role : (isOwner ? "owner" : null);

          if (!role) {
            res.status(403).json({
              success: false,
              message: "Forbidden: Cross-workspace access denied",
              error: {
                code: "FORBIDDEN_WORKSPACE_ACCESS",
                message: "Forbidden: Cross-workspace access denied",
              },
            });
            return;
          }

          if (!hasPermission(role, "forms:create")) {
            res.status(403).json({
              success: false,
              message: "Forbidden: Insufficient permissions to create forms in this workspace",
              error: {
                code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS",
                message: "Forbidden: Insufficient permissions to create forms in this workspace",
              },
            });
            return;
          }
        }

        resolvedWorkspaceId = targetWs._id.toString();
      }
    } else if (req.headers["x-workspace-slug"]) {
      const slugVal = Array.isArray(req.headers["x-workspace-slug"])
        ? req.headers["x-workspace-slug"][0]
        : String(req.headers["x-workspace-slug"]).trim().toLowerCase();
      const targetWs = await Workspace.findOne({ slug: slugVal });
      if (!targetWs) {
        res.status(404).json({
          success: false,
          message: "Workspace not found",
          error: { message: "Workspace not found" },
        });
        return;
      }
      if (authReq.user.role !== "super_admin") {
        const membership = await Membership.findOne({
          userId: authReq.user._id,
          workspaceId: targetWs._id,
        });
        const isOwner = targetWs.owner.toString() === authReq.user._id.toString();
        const role = membership ? membership.role : (isOwner ? "owner" : null);

        if (!role) {
          res.status(403).json({
            success: false,
            message: "Forbidden: Cross-workspace access denied",
            error: {
              code: "FORBIDDEN_WORKSPACE_ACCESS",
              message: "Forbidden: Cross-workspace access denied",
            },
          });
          return;
        }

        if (!hasPermission(role, "forms:create")) {
          res.status(403).json({
            success: false,
            message: "Forbidden: Insufficient permissions to create forms in this workspace",
            error: {
              code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS",
              message: "Forbidden: Insufficient permissions to create forms in this workspace",
            },
          });
          return;
        }
      }
      resolvedWorkspaceId = targetWs._id.toString();
    } else {
      // Default: caller's active workspace (or null if caller has no workspace, satisfying C1.6)
      const defaultWsId = authReq.workspaceId || (await getWorkspaceIdFromUser(authReq.user));
      resolvedWorkspaceId = defaultWsId || null;
    }

    // Step 3: Clean helper fields and set createdBy
    delete (validatedData as any).workspaceId;
    delete (validatedData as any).destinationWorkspaceId;
    (validatedData as any).createdBy = authReq.user._id;

    // Step 4: Delegate to FormService
    const form = await formService.createForm(resolvedWorkspaceId, validatedData as any);

    res.status(201).json({
      _id: form._id,
      title: form.title,
      description: form.description,
      workspaceId: form.workspaceId,
      createdBy: form.createdBy,
      status: form.status,
      fields: form.fields,
      pages: form.pages,
      branding: form.branding,
      settings: form.settings,
      slug: form.status === "published" ? (form.publishedSlug || form.slug) : form.slug,
      publishedSlug: form.publishedSlug,
      publishedAt: form.publishedAt,
      schemaVersion: form.schemaVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      // For compatibility
      success: true,
      message: "Form created successfully",
      form,
    });
  } catch (error) {
    next(error);
  }
};

export const getForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const formId = req.params.formId || req.params.id;

    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to access this form",
        error: { message: "Forbidden: You do not have permission to access this form" }
      });
      return;
    }

    const form = await formService.getFormById(formId as string, workspaceId, !workspaceId || !!authReq.formAccessGrant);

    res.status(200).json({
      _id: form._id,
      title: form.title,
      description: form.description,
      workspaceId: form.workspaceId,
      status: form.status,
      fields: form.fields,
      pages: form.pages,
      branding: form.branding,
      settings: form.settings,
      slug: form.status === "published" ? (form.publishedSlug || form.slug) : form.slug,
      publishedSlug: form.publishedSlug,
      publishedAt: form.publishedAt,
      schemaVersion: form.schemaVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      // For compatibility
      success: true,
      form,
    });
  } catch (error) {
    next(error);
  }
};

export const listForms = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const workspaceId = authReq.explicitPersonalContext
      ? ""
      : (authReq.workspaceId || await getWorkspaceIdFromUser(authReq.user));

    // Extract query parameters for search, status, and pagination
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const result = await formService.listForms(workspaceId || "", {
      search,
      status,
      page,
      limit,
      // C1.6: no active workspace -> list the caller's personal (workspaceId: null) forms instead of nothing
      personalUserId: workspaceId ? undefined : authReq.user._id.toString(),
    });

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};

export const updateForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const formId = req.params.formId || req.params.id;
    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to update this form",
        error: { message: "Forbidden: You do not have permission to update this form" }
      });
      return;
    }

    const form = await formService.updateForm(formId as string, workspaceId, req.body);

    res.status(200).json({
      _id: form._id,
      title: form.title,
      description: form.description,
      workspaceId: form.workspaceId,
      status: form.status,
      fields: form.fields,
      pages: form.pages,
      branding: form.branding,
      settings: form.settings,
      slug: form.status === "published" ? (form.publishedSlug || form.slug) : form.slug,
      publishedSlug: form.publishedSlug,
      publishedAt: form.publishedAt,
      schemaVersion: form.schemaVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      // For compatibility
      success: true,
      message: "Form updated successfully",
      form,
    });
  } catch (error) {
    next(error);
  }
};

export const patchForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const formId = req.params.formId || req.params.id;
    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to update this form",
        error: { message: "Forbidden: You do not have permission to update this form" }
      });
      return;
    }

    // Validate payload using Zod patch schema
    const validatedData = patchFormSchema.parse(req.body);

    if (validatedData.status === "published") {
      const form = await formService.publishForm(formId as string, workspaceId, validatedData);
      res.status(200).json({
        _id: form._id,
        status: form.status,
        slug: form.publishedSlug,
        publishedAt: form.publishedAt,
        success: true,
      });
      return;
    }

    const form = await formService.patchForm(formId as string, workspaceId, validatedData);

    res.status(200).json({
      _id: form._id,
      title: form.title,
      description: form.description,
      workspaceId: form.workspaceId,
      status: form.status,
      fields: form.fields,
      pages: form.pages,
      branding: form.branding,
      settings: form.settings,
      slug: form.status === "published" ? (form.publishedSlug || form.slug) : form.slug,
      publishedSlug: form.publishedSlug,
      publishedAt: form.publishedAt,
      schemaVersion: form.schemaVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      // For compatibility
      success: true,
      message: "Form updated successfully",
      form,
    });
  } catch (error) {
    next(error);
  }
};

export const publishForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const formId = req.params.formId || req.params.id;
    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to publish this form",
        error: { message: "Forbidden: You do not have permission to publish this form" }
      });
      return;
    }

    const form = await formService.publishForm(formId as string, workspaceId);

    res.status(200).json({
      _id: form._id,
      status: form.status,
      slug: form.publishedSlug,
      publishedSlug: form.publishedSlug,
      publishedAt: form.publishedAt,
      success: true,
    });
  } catch (error) {
    next(error);
  }
};

export const closeForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const formId = req.params.formId || req.params.id;
    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to close this form",
        error: { message: "Forbidden: You do not have permission to close this form" }
      });
      return;
    }

    const form = await formService.closeForm(formId as string, workspaceId);

    res.status(200).json({
      _id: form._id,
      status: form.status,
      success: true,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const formId = req.params.formId || req.params.id;
    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to delete this form",
        error: { message: "Forbidden: You do not have permission to delete this form" }
      });
      return;
    }

    await formService.deleteForm(formId as string, workspaceId);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const submitForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { formId } = req.params;
    const { answers } = req.body;

    const submission = await formService.submitForm(formId as string, answers);

    res.status(201).json({
      success: true,
      message: "Response submitted successfully",
      submission,
    });
  } catch (error) {
    next(error);
  }
};

export const getSubmissions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const { formId } = req.params;
    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to view submissions for this form",
        error: { message: "Forbidden: You do not have permission to view submissions for this form" }
      });
      return;
    }

    const submissions = await formService.getSubmissions(formId as string, workspaceId, !workspaceId || !!authReq.formAccessGrant);

    res.status(200).json({
      success: true,
      submissions,
    });
  } catch (error) {
    next(error);
  }
};

export const duplicateForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    if (req.body?.workspaceId || req.params?.workspaceId) {
      res.status(400).json({
        success: false,
        message: "workspaceId must not be provided in body or params",
        error: { message: "workspaceId must not be provided in body or params" }
      });
      return;
    }

    const formId = req.params.formId || req.params.id;
    const { formDoc, workspaceId, isAuthorized } = await resolveFormAccess(
      formId as string,
      authReq.user,
      authReq.formAccessGrant
    );

    if (!formDoc) {
      res.status(404).json({
        success: false,
        message: "Form not found",
        error: { message: "Form not found" }
      });
      return;
    }

    if (!isAuthorized) {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to duplicate this form",
        error: { message: "Forbidden: You do not have permission to duplicate this form" }
      });
      return;
    }

    const form = await formService.duplicateForm(formId as string, workspaceId);

    res.status(201).json({
      _id: form._id,
      title: form.title,
      description: form.description,
      workspaceId: form.workspaceId,
      status: form.status,
      fields: form.fields,
      pages: form.pages,
      branding: form.branding,
      settings: form.settings,
      slug: form.status === "published" ? (form.publishedSlug || form.slug) : form.slug,
      publishedSlug: form.publishedSlug,
      publishedAt: form.publishedAt,
      schemaVersion: form.schemaVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      // For compatibility
      success: true,
      message: "Form duplicated successfully",
      form,
    });
  } catch (error) {
    next(error);
  }
};

export const getPublicFormBySlug = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const slug = req.params.slug as string;
    const formDoc = await formService.getPublicFormBySlug(slug);
    const form = formDoc.toObject();

    // Set cache headers to prevent caching so updates are instantly reflected
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

    // Strip internal properties (workspaceId, preview slug, honeypot settings) and soft-deleted fields
    const fields = (form.fields || []).filter((f: any) => !f.deleted);
    const publicFields = fields.map((raw: any) => {
      const cleanField: any = {
        fieldId: raw.fieldId,
        pageId: raw.pageId,
        label: raw.label,
        type: raw.type,
        required: raw.required,
        placeholder: raw.placeholder !== undefined ? raw.placeholder : "",
        helpText: raw.helpText !== undefined ? raw.helpText : "",
      };
      if (raw.minLength !== undefined) cleanField.minLength = raw.minLength;
      if (raw.maxLength !== undefined) cleanField.maxLength = raw.maxLength;
      if (raw.pattern !== undefined) cleanField.pattern = raw.pattern;
      if (raw.min !== undefined) cleanField.min = raw.min;
      if (raw.max !== undefined) cleanField.max = raw.max;
      if (raw.minDate !== undefined) cleanField.minDate = raw.minDate;
      if (raw.maxDate !== undefined) cleanField.maxDate = raw.maxDate;
      if (raw.options !== undefined && raw.options.length > 0) cleanField.options = raw.options;
      if (raw.maxFileSize !== undefined) cleanField.maxFileSize = raw.maxFileSize;
      if (raw.allowedMimeTypes !== undefined && raw.allowedMimeTypes.length > 0) {
        cleanField.allowedMimeTypes = raw.allowedMimeTypes;
      }
      if (raw.logicRules !== undefined && raw.logicRules.length > 0) {
        cleanField.logicRules = raw.logicRules.map((rule: any) => ({
          ruleId: rule.ruleId,
          targetFieldId: rule.targetFieldId,
          condition: rule.condition,
          operator: rule.operator,
          value: rule.value,
          action: rule.action,
        }));
      }
      return cleanField;
    });

    const pages = (form.pages || []).map((raw: any) => {
      return {
        id: raw.id,
        order: raw.order,
        title: raw.title,
        description: raw.description,
      };
    });

    const branding = form.branding || {};
    const cleanBranding: any = {
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
      coverImageUrl: branding.coverImageUrl,
    };

    const settings = form.settings || {};
    const cleanSettings: any = {};
    if (settings.successMessage !== undefined) cleanSettings.successMessage = settings.successMessage;
    if (settings.layout !== undefined) cleanSettings.layout = settings.layout;
    if (settings.responseLimitEnabled !== undefined) cleanSettings.responseLimitEnabled = settings.responseLimitEnabled;
    if (settings.responseLimit !== undefined) cleanSettings.responseLimit = settings.responseLimit;
    if (settings.closeDate !== undefined) cleanSettings.closeDate = settings.closeDate;

    res.status(200).json({
      success: true,
      _id: form._id,
      title: form.title,
      description: form.description,
      status: form.status,
      fields: publicFields,
      pages,
      branding: cleanBranding,
      settings: cleanSettings,
      publishedSlug: form.publishedSlug,
      publishedAt: form.publishedAt,
    });
  } catch (error) {
    next(error);
  }
};

const cleanupUploadedFiles = async (files: Express.Multer.File[], deleteFromDb = false) => {
  if (!files || files.length === 0) return;
  const uploadDir = getUploadDir();
  for (const file of files) {
    const filePath = path.resolve(uploadDir, file.filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error("Failed to delete physical file during cleanup:", e);
      }
    }
    if (deleteFromDb) {
      try {
        await Upload.deleteOne({ path: file.filename });
      } catch (e) {
        console.error("Failed to delete Upload document during cleanup:", e);
      }
    }
  }
};

export const submitPublicForm = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let submissionSuccess = false;
  try {
    const slug = req.params.slug as string;
    const { data, _hp } = req.body;

    // Retrieve the published form first to use its fields for answers normalization
    const formDoc = await formService.getPublicFormBySlug(slug);
    const form = formDoc.toObject();

    // Parse answers JSON
    let answers: Record<string, any> = {};
    let parsed: any = null;

    if (data) {
      try {
        parsed = typeof data === "string" ? JSON.parse(data) : data;
      } catch (e) {
        res.status(422).json({
          success: false,
          message: "Validation failed",
          errors: [{ field: "data", message: "Invalid JSON format in data field" }],
          error: { message: "Validation failed" }
        });
        return;
      }
    } else if (req.body && typeof req.body === "object") {
      parsed = req.body;
    }

    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.answers)) {
        // Array of answer objects (reconciled frontend shape)
        for (const ans of parsed.answers) {
          if (ans && typeof ans === "object") {
            const field = form.fields.find(
              (f: any) =>
                (f.fieldId && String(f.fieldId) === String(ans.fieldId)) ||
                (f._id && String(f._id) === String(ans.fieldId)) ||
                (f.label && ans.fieldLabel && f.label.trim() === ans.fieldLabel.trim()) ||
                (f.label && ans.label && f.label.trim() === ans.label.trim())
            );
            const value = ans.value;
            if (field) {
              if (field.fieldId) answers[field.fieldId] = value;
              if (field._id) answers[field._id.toString()] = value;
              answers[field.label] = value;
            } else {
              if (ans.fieldId !== undefined) answers[ans.fieldId] = value;
              if (ans.fieldLabel !== undefined) answers[ans.fieldLabel] = value;
              if (ans.label !== undefined) answers[ans.label] = value;
            }
          }
        }
      } else {
        // Flat key-value map inside JSON / body object
        for (const key of Object.keys(parsed)) {
          if (key !== "data" && key !== "_hp") {
            const val = parsed[key];
            const field = form.fields.find(
              (f: any) =>
                (f.fieldId && String(f.fieldId) === String(key)) ||
                (f._id && String(f._id) === String(key)) ||
                (f.label && f.label.trim() === key.trim())
            );
            if (field) {
              if (field.fieldId) answers[field.fieldId] = val;
              if (field._id) answers[field._id.toString()] = val;
              answers[field.label] = val;
            } else {
              answers[key] = val;
            }
          }
        }
      }
    }

    // Flat multipart keys directly in req.body (e.g. key=value form-data)
    if (Object.keys(answers).length === 0 && req.body && typeof req.body === "object") {
      for (const key of Object.keys(req.body)) {
        if (key !== "data" && key !== "_hp") {
          const val = req.body[key];
          const field = form.fields.find(
            (f: any) =>
              (f.fieldId && String(f.fieldId) === String(key)) ||
              (f._id && String(f._id) === String(key)) ||
              (f.label && f.label.trim() === key.trim())
          );
          if (field) {
            if (field.fieldId) answers[field.fieldId] = val;
            if (field._id) answers[field._id.toString()] = val;
            answers[field.label] = val;
          } else {
            answers[key] = val;
          }
        }
      }
    }

    // Honeypot check for bots (silent discard)
    if (_hp) {
      const clientIp = getRealClientIp(req);
      const hashedIp = hashIp(clientIp);

      SystemLog.create({
        level: "warn",
        message: "Honeypot silent drop triggered",
        route: req.originalUrl,
        statusCode: 200,
        meta: {
          type: "honeypot_drop",
          ipHash: hashedIp,
          slug: form.publishedSlug || form.slug
        }
      }).catch(err => console.error("Error logging honeypot drop to SystemLog:", err));

      res.status(200).json({
        success: true,
        message: "Response submitted successfully",
        submission: {
          _id: new mongoose.Types.ObjectId().toString(),
          formId: form._id,
          answers: answers,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });
      return;
    }

    // Enforce 100 MB absolute limit on all uploaded files
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files as Express.Multer.File[]) {
        const fileSizeMB = file.size / (1024 * 1024);
        if (fileSizeMB > 100) {
          res.status(422).json({
            success: false,
            message: "Validation failed",
            errors: [{
              field: file.fieldname,
              message: `File size exceeds the absolute limit of 100 MB.`
            }],
            error: { message: "Validation failed" }
          });
          return;
        }
      }
    }

    // Map and validate files matching file_upload fields
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      for (const field of form.fields) {
        if (field.type === "file_upload" && !field.deleted) {
          const file = (req.files as Express.Multer.File[]).find(
            (f) => f.fieldname === field.label || f.fieldname === field.fieldId
          );
          if (file) {
            // Validate file size limit (in MB)
            if (field.maxFileSize !== undefined) {
              const fileSizeMB = file.size / (1024 * 1024);
              if (fileSizeMB > field.maxFileSize) {
                res.status(422).json({
                  success: false,
                  message: "Validation failed",
                  errors: [{
                    field: field.label,
                    message: `Field "${field.label}" file size exceeds the limit of ${field.maxFileSize} MB.`
                  }],
                  error: { message: "Validation failed" }
                });
                return;
              }
            }
            // Validate file MIME types
            if (field.allowedMimeTypes && field.allowedMimeTypes.length > 0) {
              if (!field.allowedMimeTypes.includes(file.mimetype)) {
                res.status(422).json({
                  success: false,
                  message: "Validation failed",
                  errors: [{
                    field: field.label,
                    message: `Field "${field.label}" file type "${file.mimetype}" is not allowed. Allowed types: ${field.allowedMimeTypes.join(", ")}.`
                  }],
                  error: { message: "Validation failed" }
                });
                return;
              }
            }

            // Create Upload metadata document
            const workspace = await Workspace.findById(form.workspaceId);
            if (!workspace) {
              res.status(400).json({
                success: false,
                message: "Workspace not found",
              });
              return;
            }

            const ctx = (req as any).uploadContext;
            const relPath = ctx ? path.join(ctx.userId, ctx.formId, "responses", ctx.responseId, file.filename) : file.filename;
            
            await Upload.create({
              name: file.originalname,
              size: file.size,
              type: file.mimetype,
              path: relPath,
              owner: workspace.owner,
              uploadTime: new Date(),
              isBranding: false,
            });

            // Map safe file URL to response answers key
            const urlPath = relPath.replace(/\\/g, "/");
            const fileUrl = `${req.protocol}://${req.get("host")}/api/upload/file/${urlPath}`;
            answers[field.label] = {
              fileName: fileUrl,
              fileSize: file.size,
              mimeType: file.mimetype,
            };

            // Link each stored file's key/path to its answer fieldId on the response record
            if (field.fieldId) {
              answers[field.fieldId] = relPath;
            }
          }
        }
      }
    }

    // Strip raw ObjectId/UUID/fieldId keys from answers — only keep human-readable label keys
    const labelKeys = new Set(form.fields.map((f: any) => f.label));
    const fieldIdKeys = new Set(form.fields.map((f: any) => f.fieldId).filter(Boolean));
    const idPattern = /^[0-9a-fA-F]{24}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    for (const key of Object.keys(answers)) {
      if (!labelKeys.has(key) && (idPattern.test(key) || fieldIdKeys.has(key))) {
        delete answers[key];
      }
    }

    // Calculate client IP hash (SHA-256, never raw IP)
    const clientIp = getRealClientIp(req);
    const hashedIp = hashIp(clientIp);

    // Call dynamic validation and persistence routine in formService
    const ctx = (req as any).uploadContext;
    const submission = await formService.submitForm(form._id.toString(), answers, hashedIp, ctx?.responseId);
    submissionSuccess = true;

    // Create form_activity notification for workspace owner
    try {
      const ws = await Workspace.findById(form.workspaceId);
      if (ws && ws.owner) {
        await Notification.create({
          userId: ws.owner,
          workspaceId: form.workspaceId,
          type: "form_activity",
          title: "New Response Received",
          message: `New response submitted for form "${form.title}"`,
        });
      }
    } catch (nErr) {
      console.warn("Failed to create form_activity notification:", nErr);
    }

    // Write response.json to disk inside responses/<responseId>/
    if (ctx) {
      const targetDir = path.join(getUploadDir(), ctx.userId, ctx.formId, "responses", ctx.responseId);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(targetDir, "response.json"),
        JSON.stringify({
          _id: submission._id.toString(),
          formId: form._id.toString(),
          answers: answers,
          createdAt: (submission as any).createdAt || new Date(),
          submittedAt: (submission as any).submittedAt || new Date(),
          ipHash: hashedIp
        }, null, 2)
      );
    }

    const submissionObj = submission.toObject();
    delete (submissionObj as any).ipHash;

    res.status(200).json({
      success: true,
      message: "Response submitted successfully",
      submission: submissionObj,
    });
  } catch (error) {
    next(error);
  } finally {
    if (!submissionSuccess && req.files && Array.isArray(req.files) && req.files.length > 0) {
      await cleanupUploadedFiles(req.files as Express.Multer.File[], true);
    }
  }
};

export const moveForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const rawFormId = req.params.formId || req.params.id;
    const formId = (Array.isArray(rawFormId) ? rawFormId[0] : rawFormId) || "";
    if (!mongoose.Types.ObjectId.isValid(formId)) {
      res.status(400).json({ success: false, message: "Invalid form ID" });
      return;
    }

    const form = await Form.findById(formId);
    if (!form) {
      res.status(404).json({ success: false, message: "Form not found" });
      return;
    }

    const userId = authReq.user._id;
    const isSuperAdmin = authReq.user.role === "super_admin";

    // 1. Source check: Caller must have forms:write (or forms:delete / admin / owner) on form's current workspace,
    // or be form creator if personal form.
    if (!isSuperAdmin) {
      if (form.workspaceId) {
        const sourceWsId = form.workspaceId.toString();
        const sourceMembership = await Membership.findOne({ userId, workspaceId: sourceWsId });
        const isSourceOwner = await Workspace.exists({ _id: sourceWsId, owner: userId });
        const sourceRole = sourceMembership ? sourceMembership.role : (isSourceOwner ? "owner" : null);

        if (!sourceRole || (!hasPermission(sourceRole, "forms:write") && !hasPermission(sourceRole, "forms:delete"))) {
          res.status(403).json({
            success: false,
            message: "Forbidden: You do not have permission to move this form from its source workspace",
            error: {
              code: "FORBIDDEN_WORKSPACE_ACCESS",
              message: "Forbidden: You do not have permission to move this form from its source workspace",
            },
          });
          return;
        }
      } else {
        // Personal form: caller must be the creator (or match authReq.user._id)
        if (form.createdBy && form.createdBy.toString() !== userId.toString()) {
          res.status(403).json({
            success: false,
            message: "Forbidden: You do not own this personal form",
            error: {
              code: "FORBIDDEN_ACCESS",
              message: "Forbidden: You do not own this personal form",
            },
          });
          return;
        }
      }
    }

    // 2. Destination check
    const targetWsInput =
      req.body.targetWorkspaceId !== undefined
        ? req.body.targetWorkspaceId
        : req.body.workspaceId !== undefined
        ? req.body.workspaceId
        : req.body.destinationWorkspaceId;

    // Personal space support: targetWorkspaceId: null or "personal" moves form to caller's personal space (C1.6)
    if (targetWsInput === null || targetWsInput === "personal" || targetWsInput === "null") {
      form.workspaceId = null;
      if (!form.createdBy) {
        form.createdBy = userId;
      }
      await form.save();

      res.status(200).json({
        success: true,
        message: "Form moved successfully",
        form,
      });
      return;
    }

    if (targetWsInput === undefined || targetWsInput === "") {
      res.status(400).json({
        success: false,
        message: "targetWorkspaceId is required",
      });
      return;
    }

    const targetWsStr = String(targetWsInput).trim();
    let targetWs: any = null;

    if (mongoose.Types.ObjectId.isValid(targetWsStr)) {
      targetWs = await Workspace.findById(targetWsStr);
    }
    if (!targetWs) {
      targetWs = await Workspace.findOne({ slug: targetWsStr.toLowerCase() });
    }

    if (!targetWs) {
      res.status(404).json({
        success: false,
        message: "Target workspace not found",
      });
      return;
    }

    if (targetWs.status === "suspended") {
      res.status(403).json({
        success: false,
        message: "Forbidden: Target workspace is suspended",
      });
      return;
    }

    // Destination check: Caller must have forms:create on the target workspace
    if (!isSuperAdmin) {
      const destMembership = await Membership.findOne({ userId, workspaceId: targetWs._id });
      const isDestOwner = targetWs.owner.toString() === userId.toString();
      const destRole = destMembership ? destMembership.role : (isDestOwner ? "owner" : null);

      if (!destRole || !hasPermission(destRole, "forms:create")) {
        res.status(403).json({
          success: false,
          message: "Forbidden: You do not have permission to create forms in the target workspace",
          error: {
            code: "FORBIDDEN_WORKSPACE_ACCESS",
            message: "Forbidden: Cross-workspace access denied",
          },
        });
        return;
      }
    }

    // Integrity guarantee: Preserves all fields, submissions, responses, and published/draft slugs untouched — only workspaceId pointer changes
    form.workspaceId = targetWs._id;
    await form.save();

    res.status(200).json({
      success: true,
      message: "Form moved successfully",
      form,
    });
  } catch (error) {
    next(error);
  }
};

export const listFormGrants = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawId = req.params.formId || req.params.id;
    const grants = await FormAccessGrant.find({ formId: rawId })
      .populate("userId", "fullName email avatarUrl")
      .sort({ createdAt: -1 })
      .lean();

    const formatted = grants.map((g: any) => {
      const isWrite =
        g.role === "admin" ||
        g.role === "editor" ||
        g.role === "member" ||
        g.role === "owner" ||
        g.role === "write";
      const accessLevel = isWrite ? "write" : "read";
      const email = g.userId?.email || "";
      const fullName = g.userId?.fullName || "User";
      return {
        id: g._id.toString(),
        _id: g._id,
        formId: g.formId.toString(),
        userId: g.userId?._id ? g.userId._id.toString() : g.userId?.toString(),
        email,
        name: fullName,
        fullName,
        user: g.userId
          ? {
              id: g.userId._id ? g.userId._id.toString() : "",
              fullName,
              name: fullName,
              email,
              avatarUrl: g.userId.avatarUrl || null,
            }
          : null,
        role: g.role,
        accessLevel,
        permission: accessLevel,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      };
    });

    res.status(200).json({
      success: true,
      grants: formatted,
      total: formatted.length,
      data: formatted,
    });
  } catch (error) {
    next(error);
  }
};

export const createFormGrant = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const rawId = req.params.formId || req.params.id;
    const { email, userId, role, accessLevel, permission } = req.body;

    let targetUserId: string | null = userId;
    if (!targetUserId && email) {
      const u = await User.findOne({ email: email.toLowerCase().trim() });
      if (u) {
        targetUserId = u._id.toString();
      } else {
        res.status(404).json({
          success: false,
          message: "User with this email does not exist",
          error: { message: "User with this email does not exist" },
        });
        return;
      }
    }

    if (!targetUserId) {
      res.status(400).json({
        success: false,
        message: "email or userId is required",
        error: { message: "email or userId is required" },
      });
      return;
    }

    // Support both 2-tier (accessLevel: 'read' | 'write') and 4-tier / 6-tier roles
    let assignedRole = role || accessLevel || permission || "reviewer";
    if (assignedRole === "write") assignedRole = "member";
    if (assignedRole === "read") assignedRole = "viewer";

    const validRoles = ["admin", "editor", "member", "reviewer", "viewer"];
    if (!validRoles.includes(assignedRole)) {
      res.status(400).json({
        success: false,
        message: `Invalid role: must be one of ${validRoles.join(", ")} or read/write`,
        error: { message: `Invalid role: must be one of ${validRoles.join(", ")} or read/write` },
      });
      return;
    }

    const grant = await FormAccessGrant.findOneAndUpdate(
      { formId: rawId, userId: targetUserId },
      {
        formId: rawId,
        userId: targetUserId,
        role: assignedRole,
        grantedBy: authReq.user._id,
      },
      { upsert: true, returnDocument: "after", new: true }
    );

    const grantObj = grant ? (grant.toObject ? grant.toObject() : grant) : {};
    const isWrite =
      assignedRole === "admin" ||
      assignedRole === "editor" ||
      assignedRole === "member" ||
      assignedRole === "owner";
    const resAccessLevel = isWrite ? "write" : "read";

    const targetUser = await User.findById(targetUserId).select("fullName email avatarUrl").lean();
    const userEmail = targetUser?.email || email || "";
    const userFullName = targetUser?.fullName || "User";

    res.status(201).json({
      success: true,
      message: "Form access grant saved successfully",
      grant: {
        ...grantObj,
        email: userEmail,
        name: userFullName,
        fullName: userFullName,
        user: targetUser
          ? {
              id: targetUser._id.toString(),
              fullName: userFullName,
              name: userFullName,
              email: userEmail,
              avatarUrl: targetUser.avatarUrl || null,
            }
          : null,
        accessLevel: resAccessLevel,
        permission: resAccessLevel,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const revokeFormGrant = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawId = req.params.formId || req.params.id;
    const rawUser = req.params.userId;
    const userIdStr = String(Array.isArray(rawUser) ? rawUser[0] : rawUser || "").trim();

    const orConditions: any[] = [];
    if (mongoose.Types.ObjectId.isValid(userIdStr)) {
      orConditions.push({ _id: userIdStr });
      orConditions.push({ userId: userIdStr });
    }

    if (orConditions.length > 0) {
      await FormAccessGrant.findOneAndDelete({
        formId: rawId,
        $or: orConditions,
      });
    }

    res.status(200).json({
      success: true,
      message: "Form access grant revoked successfully",
    });
  } catch (error) {
    next(error);
  }
};



