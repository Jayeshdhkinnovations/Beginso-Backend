import { Request, Response, NextFunction } from "express";
import { FormService } from "../services/form.service";
import { evaluateReadiness } from "../services/readiness.service";
import { recordEvent } from "../services/event.service";
import { normaliseSubmittedAnswers } from "../utils/answers";
import { resolveFormAccess } from "./form.controller";

// Sprint 13 (BE 0.3, 0.4, 0.8): the form lifecycle endpoints that sit beside publish/close - readiness,
// unpublish, regenerate-link, archive/unarchive and test submissions. Permission is enforced by
// requirePermission on each route (see form.routes.ts); resolveFormAccess below only locates the form and
// re-confirms the caller can reach it, exactly as every existing form handler does.

const formService = new FormService();

const fail = (res: Response, status: number, message: string, code?: string): void => {
  res.status(status).json({ success: false, message, error: { message, ...(code ? { code } : {}) } });
};

// Locates the form and confirms access. Sends the error response itself and returns null when the
// caller should stop.
const locate = async (req: Request, res: Response) => {
  const authReq = req as any;
  if (!authReq.user) {
    fail(res, 401, "Not authorized");
    return null;
  }
  if (req.body?.workspaceId || req.params?.workspaceId) {
    fail(res, 400, "workspaceId must not be provided in body or params");
    return null;
  }
  const formId = String(req.params.formId || req.params.id);
  const access = await resolveFormAccess(formId, authReq.user, authReq.formAccessGrant);
  if (!access.formDoc) {
    fail(res, 404, "Form not found");
    return null;
  }
  if (!access.isAuthorized) {
    fail(res, 403, "Forbidden: You do not have permission for this form");
    return null;
  }
  return { formId, ...access };
};

const slugOf = (form: any): string | undefined =>
  form.status === "published" ? form.publishedSlug || form.slug : form.publishedSlug || form.slug;

// GET /api/forms/:formId/readiness
export const getReadiness = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ctx = await locate(req, res);
    if (!ctx) return;
    res.status(200).json({ success: true, ...evaluateReadiness(ctx.formDoc) });
  } catch (error) {
    next(error);
  }
};

// POST /api/forms/:formId/unpublish
export const unpublishForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ctx = await locate(req, res);
    if (!ctx) return;
    const form = await formService.unpublishForm(ctx.formId, ctx.workspaceId);
    await recordEvent(req, form.workspaceId, "form.unpublish", { id: form._id, type: "form", label: form.title });
    res.status(200).json({ success: true, _id: form._id, status: form.status, slug: slugOf(form), publishedSlug: form.publishedSlug });
  } catch (error) {
    next(error);
  }
};

// POST /api/forms/:formId/regenerate-link
export const regenerateLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ctx = await locate(req, res);
    if (!ctx) return;
    const { form, previousSlug } = await formService.regenerateLink(ctx.formId, ctx.workspaceId);
    await recordEvent(req, form.workspaceId, "form.regenerate_link", { id: form._id, type: "form", label: form.title }, { previousSlug });
    res.status(200).json({
      success: true,
      _id: form._id,
      slug: form.publishedSlug,
      publishedSlug: form.publishedSlug,
      previousSlugInvalidated: true,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/forms/:formId/archive  ·  POST /api/forms/:formId/unarchive
export const archiveForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ctx = await locate(req, res);
    if (!ctx) return;
    const form = await formService.archiveForm(ctx.formId, ctx.workspaceId, (req as any).user._id);
    await recordEvent(req, form.workspaceId, "form.archive", { id: form._id, type: "form", label: form.title });
    res.status(200).json({ success: true, _id: form._id, archivedAt: form.archivedAt });
  } catch (error) {
    next(error);
  }
};

export const unarchiveForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ctx = await locate(req, res);
    if (!ctx) return;
    const form = await formService.unarchiveForm(ctx.formId, ctx.workspaceId);
    await recordEvent(req, form.workspaceId, "form.unarchive", { id: form._id, type: "form", label: form.title });
    res.status(200).json({ success: true, _id: form._id, archivedAt: null });
  } catch (error) {
    next(error);
  }
};

// POST /api/forms/:formId/test-submissions
// Sends the current form through the REAL validation and storage path with `isTest: true`, so the owner
// can confirm what a respondent will get and that a response lands as expected - without any of it
// counting. A test never gets a public reference number, never emails anyone, never creates a respondent
// link, never trips the response limit and is excluded from every count (Response model hooks).
export const createTestSubmission = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ctx = await locate(req, res);
    if (!ctx) return;
    const form = ctx.formDoc;
    const answers = normaliseSubmittedAnswers(form, req.body);
    const response = await formService.submitForm(ctx.formId, answers, undefined, undefined, {
      isTest: true,
      respondentUserId: (req as any).user._id,
    });
    res.status(201).json({ success: true, _id: response._id, isTest: true });
  } catch (error) {
    next(error);
  }
};
