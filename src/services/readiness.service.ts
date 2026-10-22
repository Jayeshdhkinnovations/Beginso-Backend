import { IForm } from "../models/Form";
import { getAccessMode } from "../utils/accessMode";
import { normaliseLayout } from "../utils/layout";

// Sprint 13, BE 0.4 (CF2.5 / CF6.5). ONE evaluation of "is this form fit to publish", used by
// GET /forms/:id/readiness AND by publishForm itself, so the pre-flight screen and the server can never
// disagree. `blocking` stops a publish (the same two rules the backend has always enforced, with the
// same stable codes); `warnings` are shown inline and never stop it.
export interface ReadinessIssue {
  code: string;
  fieldId?: string;
  message: string;
}

export interface ReadinessResult {
  ready: boolean;
  blocking: ReadinessIssue[];
  warnings: ReadinessIssue[];
}

// dropdown / multiple_choice must offer something to choose. A checkbox with no options is a plain
// yes/no box, which is valid - so it is deliberately not in this list.
const CHOICE_FIELD_TYPES = ["dropdown", "multiple_choice"];

type ReadinessSubject = Pick<IForm, "fields"> & { settings?: IForm["settings"] | null };

export const evaluateReadiness = (form: ReadinessSubject, now: Date = new Date()): ReadinessResult => {
  const blocking: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];

  const visible = (form.fields ?? []).filter((f) => !f.deleted);

  if (visible.length === 0) {
    blocking.push({ code: "FORM_HAS_NO_FIELDS", message: "Form must have at least one field to be published" });
  }

  for (const field of visible) {
    if (CHOICE_FIELD_TYPES.includes(field.type) && (!field.options || field.options.length === 0)) {
      blocking.push({
        code: "CHOICE_FIELD_HAS_NO_OPTIONS",
        fieldId: field.fieldId,
        message: `Field "${field.label}" must have at least one option to be published`,
      });
    }
  }

  // Answers are keyed by label, so an empty or repeated label is a real data problem, not just cosmetics.
  const seen = new Map<string, string | undefined>();
  for (const field of visible) {
    const label = (field.label ?? "").trim();
    if (label === "") {
      warnings.push({ code: "FIELD_LABEL_EMPTY", fieldId: field.fieldId, message: "A field has no label - respondents will see an empty prompt" });
      continue;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      warnings.push({
        code: "FIELD_LABEL_DUPLICATE",
        fieldId: field.fieldId,
        message: `More than one field is labelled "${label}" - their answers will be indistinguishable`,
      });
    } else {
      seen.set(key, field.fieldId);
    }
  }

  const closeDate = form.settings?.closeDate;
  if (closeDate) {
    const t = new Date(closeDate).getTime();
    if (!isNaN(t) && t < now.getTime()) {
      warnings.push({ code: "CLOSE_DATE_IN_PAST", message: "The closing date is in the past - the form will close immediately" });
    }
  }

  // Compact is two columns of dense fields: measurably worse for the public (wireframe a11y/watch-out note).
  if (normaliseLayout(form.settings?.layout) === "compact" && getAccessMode(form) !== "login") {
    warnings.push({ code: "LAYOUT_COMPACT_PUBLIC", message: "The Compact layout is meant for internal forms and converts poorly on public ones" });
  }

  return { ready: blocking.length === 0, blocking, warnings };
};
