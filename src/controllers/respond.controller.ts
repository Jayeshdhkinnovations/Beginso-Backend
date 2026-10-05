import { Request, Response, NextFunction } from "express";
import {
  claimViaLink,
  detailMine,
  editMine,
  editViaLink,
  listMine,
  resendLink,
  viewViaLink,
} from "../services/respondent.service";

// Sprint 13, BE 0.10 / 0.12 (A5.1-A5.4). Two doors onto the same service:
//  /api/respond/:token   - a signed link, no session. Token-authenticated; never carries a cookie.
//  /api/my-submissions   - a signed-in respondent, authenticated normally.
// Neither ever returns a stage name, tag, assignee, note or score (respondent.service.ts).

// A token in a URL must not be cached or leak through a referrer.
const noStore = (res: Response): void => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
};

// The edit body is `{ answers: { [fieldId]: value } }` (an array of `{ fieldId, value }` is accepted too).
const incomingAnswers = (body: any): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const source = body?.answers;
  if (Array.isArray(source)) {
    for (const a of source) if (a && typeof a === "object" && typeof a.fieldId === "string") out[a.fieldId] = a.value;
  } else if (source && typeof source === "object") {
    for (const key of Object.keys(source)) out[key] = (source as any)[key];
  }
  return out;
};

// GET /api/respond/:token
export const getRespondLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    noStore(res);
    const { httpStatus, body } = await viewViaLink(req.params.token);
    res.status(httpStatus).json({ success: httpStatus === 200, ...body });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/respond/:token
export const patchRespondLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    noStore(res);
    const result = await editViaLink(req.params.token, incomingAnswers(req.body));
    res.status(200).json({ success: true, ok: true, editedAfterReview: result.editedAfterReview });
  } catch (error) {
    next(error);
  }
};

// POST /api/respond/:token/claim - needs the session of the account just created from the link.
export const claimRespondLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    noStore(res);
    const user = (req as any).user;
    const result = await claimViaLink(req.params.token, { _id: user._id, email: user.email });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

// POST /api/respond/resend   body: { email, slug }  -> always 202, whatever matched.
export const resendRespondLink = async (req: Request, res: Response): Promise<void> => {
  noStore(res);
  await resendLink(req.body?.email, req.body?.slug);
  res.status(202).json({ success: true });
};

// GET /api/my-submissions
export const getMySubmissions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const items = await listMine((req as any).user._id);
    res.status(200).json({ success: true, items });
  } catch (error) {
    next(error);
  }
};

// GET /api/my-submissions/:id
export const getMySubmission = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const detail = await detailMine(String(req.params.id), (req as any).user._id);
    if (!detail) {
      res.status(404).json({ success: false, message: "Submission not found" });
      return;
    }
    res.status(200).json({ success: true, ...detail });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/my-submissions/:id
export const patchMySubmission = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await editMine(String(req.params.id), (req as any).user._id, incomingAnswers(req.body));
    res.status(200).json({ success: true, ok: true, editedAfterReview: result.editedAfterReview });
  } catch (error) {
    next(error);
  }
};
