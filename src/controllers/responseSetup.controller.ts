import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import Form from "../models/Form";
import { isValidId } from "../services/pin.service";
import { recordEvent } from "../services/event.service";
import { getResponseSetup, saveResponseSetup } from "../services/responseSetup.service";
import { responseSetupSchema } from "../validations/responseSetup.validator";

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ success: false, message, error: { code, message, ...extra } });

const FORM_FIELDS = "title workspaceId createdBy fields.fieldId fields.deleted";

const loadForm = async (req: Request, res: Response): Promise<any | null> => {
  const raw = req.params.formId;
  const formId = String(Array.isArray(raw) ? raw[0] : raw);
  if (!isValidId(formId)) {
    fail(res, 400, "INVALID_FORM_ID", "Invalid form ID");
    return null;
  }
  const form = await Form.findById(formId).select(FORM_FIELDS).lean();
  if (!form) {
    fail(res, 404, "FORM_NOT_FOUND", "Form not found");
    return null;
  }
  return form;
};

// GET /api/forms/:formId/response-setup - how this form's Responses page is set up. Anyone who can read the form may read it.
export const getFormResponseSetup = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    res.status(200).json({ success: true, ...(await getResponseSetup(form)) });
  } catch (error) {
    next(error);
  }
};

// PUT /api/forms/:formId/response-setup - owner and admins only (forms:configure, enforced on the route): stages, columns, card, defaults.
export const putFormResponseSetup = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await loadForm(req, res);
    if (!form) return;
    const input = responseSetupSchema.parse(req.body);
    const result = await saveResponseSetup(form, String((req as any).user._id), input);
    if (form.workspaceId) {
      await recordEvent(req, String(form.workspaceId), "form.responses_setup", { id: form._id, type: "form", label: form.title }, { stages: input.stages.mode, columns: input.tableColumns.length });
    }
    res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(422).json({
        success: false,
        message: "Validation failed",
        errors: error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
        error: { message: "Validation failed" },
      });
      return;
    }
    if (error?.statusCode) {
      fail(res, error.statusCode, error.code ?? "RESPONSE_SETUP_ERROR", error.message, error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {});
      return;
    }
    next(error);
  }
};
