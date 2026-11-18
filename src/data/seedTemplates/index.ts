// The 77 templates, ready for the catalogue: the zip's builders output, with `_showIf` turned into real show-if rules, a stable id on every field,
// the wave each belongs to (1, 2 or 3) and the old slugs it replaces. Nothing here touches a database.
import { wave1Templates } from "./wave1Templates";
import { wave2Templates } from "./wave2Templates";
import { wave3Templates } from "./wave3Templates";

/** Renamed templates: the new slug and the old slugs it replaces. When the new template's wave is synced, the old ones are switched off (never deleted). */
export const REPLACES: Record<string, string[]> = {
  "contact-us": ["general-contact-form"],
  "demo-request": ["contact-sales"],
  waitlist: ["product-waitlist"],
  "quick-rating": ["net-promoter-score"],
  "membership-signup": ["member-registration"],
  "product-order": ["product-order-form"],
  "donation-pledge": ["donation-form"],
  "appointment-booking": ["appointment-request"],
  "it-bug-request": ["it-support-request"],
  "volunteer-sign-up": ["volunteer-signup"],
  "patient-intake": ["patient-intake-form"],
  "photo-video-consent": ["photo-video-consent-form"],
  "vendor-booth-registration": ["vendor-registration"],
};

export interface ShowIfProblem {
  template: string;
  field: string;
  problem: string;
}

type Built = Record<string, any>;

/**
 * The real show-if rule lives on the question that decides (not on the one that is shown): { targetFieldId, action: "show", condition: { fieldId, operator:
 * "equals", value } }. The seed names the deciding question by its label and says "yes" in lower case, while a Yes / No answer is stored as "Yes" / "No".
 * Anything that cannot be mapped is reported, never changed to fit.
 */
export function mapTemplate(t: Built, wave: 1 | 2 | 3): { template: Built; problems: ShowIfProblem[] } {
  const problems: ShowIfProblem[] = [];
  const fields: Built[] = t.fields.map((f: Built, i: number) => ({ ...f, fieldId: `${t.slug}-${i + 1}` }));
  for (const target of fields) {
    const intent = target._showIf as { field: string; equals: string } | undefined;
    if (!intent) continue;
    const source = fields.find((f) => f.label === intent.field);
    if (!source) {
      problems.push({ template: t.slug, field: target.label, problem: `the deciding question "${intent.field}" does not exist` });
      continue;
    }
    if (source.pageId !== target.pageId && fields.indexOf(source) > fields.indexOf(target)) {
      problems.push({ template: t.slug, field: target.label, problem: "the deciding question comes after the one it controls" });
    }
    let value = intent.equals;
    if (source.type === "yes_no") {
      const v = value.trim().toLowerCase();
      if (v !== "yes" && v !== "no") problems.push({ template: t.slug, field: target.label, problem: `"${value}" is not an answer to a Yes / No question` });
      value = v === "yes" ? "Yes" : v === "no" ? "No" : value;
    } else if (Array.isArray(source.options) && !source.options.includes(value)) {
      problems.push({ template: t.slug, field: target.label, problem: `"${value}" is not one of the options of "${source.label}"` });
    } else if (source.type !== "yes_no" && source.type !== "multiple_choice" && source.type !== "dropdown") {
      problems.push({ template: t.slug, field: target.label, problem: `a show-if on a ${source.type} question is not supported (only equals on a choice or Yes / No)` });
    }
    source.logicRules = [...(source.logicRules ?? []), { targetFieldId: target.fieldId, action: "show", condition: { fieldId: source.fieldId, operator: "equals", value } }];
  }
  for (const f of fields) delete f._showIf;
  return { template: { ...t, fields, wave, replaces: REPLACES[t.slug] ?? [] }, problems };
}

const mapped = [
  ...(wave1Templates as Built[]).map((t) => mapTemplate(t, 1)),
  ...(wave2Templates as Built[]).map((t) => mapTemplate(t, 2)),
  ...(wave3Templates as Built[]).map((t) => mapTemplate(t, 3)),
];

/** All 77, in wave order (which is also their gallery order). */
export const seedTemplates: Built[] = mapped.map((m) => m.template);
/** Every show-if that could not be mapped. The seed test fails while this is not empty. */
export const showIfProblems: ShowIfProblem[] = mapped.flatMap((m) => m.problems);
