import { Request, Response, NextFunction } from "express";
import Form from "../models/Form";
import { isValidId, userCanReadForm } from "../services/pin.service";
import {
  RESPONSE_VIEW_STALE,
  clearPersonalView,
  getViewForForm,
  savePersonalView,
  saveFormDefault,
} from "../services/responseView.service";
import { clearScopeSchema, formDefaultSchema, personalViewSchema } from "../validations/responseView.validator";

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, message, error: { code, message } });

const idOf = (req: Request): string => {
  const raw = req.params.formId;
  return String(Array.isArray(raw) ? raw[0] : raw);
};

const FORM_FIELDS = "workspaceId createdBy fields.fieldId fields.deleted";

// GET /api/forms/:formId/response-view - one call per form screen. Needs responses:read on the form (route).
export const getResponseView = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const formId = idOf(req);
    if (!isValidId(formId)) return void fail(res, 400, "INVALID_FORM_ID", "Invalid form ID");
    const form: any = await Form.findById(formId).select(FORM_FIELDS).lean();
    if (!form) return void fail(res, 404, "FORM_NOT_FOUND", "Form not found");
    res.status(200).json({ success: true, ...(await getViewForForm(String((req as any).user._id), form)) });
  } catch (error) {
    next(error);
  }
};

// PUT /api/me/response-view - the caller's own choice. Any member who can open the form's responses may set it.
export const putMyResponseView = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { scope, ...settings } = personalViewSchema.parse(req.body);
    const userId = String((req as any).user._id);
    if (scope !== "all") {
      const form: any = await Form.findById(scope).select("workspaceId createdBy").lean();
      if (!form) return void fail(res, 404, "FORM_NOT_FOUND", "Form not found");
      if (!(await userCanReadForm(userId, form))) return void fail(res, 403, "FORBIDDEN_INSUFFICIENT_PERMISSIONS", "Forbidden: Insufficient permissions");
    }
    res.status(200).json({ success: true, personal: await savePersonalView(userId, scope, settings) });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/me/response-view?scope=all|<formId> - "Use the form default". Touches only the caller's own row, so it
// needs no form access (someone who lost access can still clean up) and is idempotent.
export const deleteMyResponseView = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { scope } = clearScopeSchema.parse(req.query);
    await clearPersonalView(String((req as any).user._id), scope);
    res.status(200).json({ success: true, scope, cleared: true });
  } catch (error) {
    next(error);
  }
};

// PUT /api/forms/:formId/response-view-default - the default for everyone without a personal choice. Needs forms:write
// (route), so viewers cannot change it. Hiding or pinning a field in a view is cosmetic: exports, the API and the PDF
// still include every field.
export const putFormResponseViewDefault = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const formId = idOf(req);
    if (!isValidId(formId)) return void fail(res, 400, "INVALID_FORM_ID", "Invalid form ID");
    const { expectedVersion, ...settings } = formDefaultSchema.parse(req.body);
    const form: any = await Form.findById(formId).select(FORM_FIELDS).lean();
    if (!form) return void fail(res, 404, "FORM_NOT_FOUND", "Form not found");
    const formDefault = await saveFormDefault(form, String((req as any).user._id), settings, expectedVersion);
    res.status(200).json({ success: true, formDefault });
  } catch (error: any) {
    if (error?.code === RESPONSE_VIEW_STALE) {
      return void res.status(409).json({
        success: false,
        message: error.message,
        error: { code: RESPONSE_VIEW_STALE, message: error.message },
        version: error.currentVersion,
      });
    }
    next(error);
  }
};
