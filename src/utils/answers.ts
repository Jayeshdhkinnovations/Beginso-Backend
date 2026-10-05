import { IForm } from "../models/Form";

// Sprint 13 (CF2.6). Turns the JSON a client sends for a submission into the label-keyed answers object the
// rest of the system stores. Accepts both shapes the public form endpoint accepts - an array of
// `{ fieldId, fieldLabel, value }` objects, or a flat `{ fieldId | label: value }` map - and drops
// anything that is not a question on this form, so a client can never write an arbitrary key (including
// one starting with "$") into the database. File answers are not accepted here: a test submission is
// JSON-only and file fields are exempt from validation for it.
export const normaliseSubmittedAnswers = (form: IForm, parsed: unknown): Record<string, any> => {
  const answers: Record<string, any> = {};
  if (!parsed || typeof parsed !== "object") return answers;

  const fields = (form.fields ?? []).filter((f) => !f.deleted && f.type !== "file_upload");
  const findField = (idOrLabel: unknown, label?: unknown) =>
    fields.find(
      (f) =>
        (idOrLabel !== undefined && f.fieldId && String(f.fieldId) === String(idOrLabel)) ||
        (idOrLabel !== undefined && f.label && f.label.trim() === String(idOrLabel).trim()) ||
        (label !== undefined && f.label && f.label.trim() === String(label).trim())
    );

  const source: any = parsed;
  if (Array.isArray(source.answers)) {
    for (const ans of source.answers) {
      if (!ans || typeof ans !== "object") continue;
      const field = findField(ans.fieldId, ans.fieldLabel ?? ans.label);
      if (field) answers[field.label] = ans.value;
    }
  } else {
    const flat = source.answers && typeof source.answers === "object" ? source.answers : source;
    for (const key of Object.keys(flat)) {
      const field = findField(key);
      if (field) answers[field.label] = flat[key];
    }
  }
  return answers;
};
