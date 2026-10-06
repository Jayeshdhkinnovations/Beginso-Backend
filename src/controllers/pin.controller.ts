import { Request, Response, NextFunction } from "express";
import Form from "../models/Form";
import { PIN_LIMIT, isValidId, pinForm, unpinForm, userCanReadForm } from "../services/pin.service";

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, message, error: { code, message } });

const idOf = (req: Request): string => {
  const raw = req.params.formId;
  return String(Array.isArray(raw) ? raw[0] : raw);
};

// PUT /api/forms/:formId/pin - private bookmark for the caller; needs read access only.
export const pinFormHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = String((req as any).user._id);
    const formId = idOf(req);
    if (!isValidId(formId)) return void fail(res, 400, "INVALID_FORM_ID", "Invalid form ID");

    // includeDeleted: a trashed form must answer 409, not look nonexistent.
    const form: any = await Form.findById(formId).setOptions({ includeDeleted: true }).select("workspaceId createdBy archivedAt deletedAt").lean();
    if (!form) return void fail(res, 404, "FORM_NOT_FOUND", "Form not found");
    // Never reveal state to someone who cannot read the form.
    if (!(await userCanReadForm(userId, form))) return void fail(res, 403, "FORBIDDEN_INSUFFICIENT_PERMISSIONS", "Forbidden: Insufficient permissions");
    if (form.deletedAt || form.archivedAt) {
      return void fail(res, 409, "PIN_FORM_UNAVAILABLE", "A trashed or archived form cannot be pinned");
    }

    const pin = await pinForm(userId, form);
    if (pin === "limit") return void fail(res, 400, "PIN_LIMIT", `You can pin at most ${PIN_LIMIT} forms`);
    res.status(200).json({ success: true, formId, pinned: true, pinnedAt: pin!.pinnedAt });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/forms/:formId/pin - removes only the caller's own row, so it needs no form access
// (a user who lost access must still be able to clean up) and is always 200.
export const unpinFormHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const formId = idOf(req);
    if (!isValidId(formId)) return void fail(res, 400, "INVALID_FORM_ID", "Invalid form ID");
    await unpinForm(String((req as any).user._id), formId);
    res.status(200).json({ success: true, formId, pinned: false });
  } catch (error) {
    next(error);
  }
};
