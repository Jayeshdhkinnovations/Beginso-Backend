import ResponseModel from "../models/Response";

// Sprint 12, BE 0.6 (B4.10/B8.3, OQ-6). "Which field counts as the email" is an open product
// question (requirements.md OQ-6) — this file records the assumption rather than blocking on it:
// the respondent's identity is the value of the form's first field of `type: "email"`. A form with
// no email field, or a submission that left it blank, simply never gets flagged (no forced
// fallback to some other field).
export interface FormFieldLike {
  type?: string;
  label?: string;
  fieldId?: string;
  deleted?: boolean;
}

// Answers are stored keyed by label AND fieldId (form.service.ts's createResponse writes both),
// so either key resolves to the same value; label is tried first since it is always present.
export const extractRespondentEmail = (
  fields: FormFieldLike[] | undefined,
  answers: Record<string, any>
): string | null => {
  if (!fields || !answers) return null;
  const emailField = fields.find((f) => f.type === "email" && !f.deleted);
  if (!emailField) return null;

  const raw = (emailField.label && answers[emailField.label]) ?? (emailField.fieldId && answers[emailField.fieldId]);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed || null;
};

// Earliest earlier response to the SAME form with a case-insensitively matching respondentEmail.
// `respondentEmail` is stored already lower-cased, so this is a plain equality lookup, not a regex
// scan. Returns null when there is no earlier match (including when respondentEmail is null).
export const findDuplicateOf = async (
  formId: string,
  respondentEmail: string | null
): Promise<string | null> => {
  if (!respondentEmail) return null;
  const earlier = await ResponseModel.findOne({ formId, respondentEmail, deletedAt: null })
    .sort({ submittedAt: 1, _id: 1 })
    .select("_id")
    .lean();
  return earlier ? earlier._id.toString() : null;
};
