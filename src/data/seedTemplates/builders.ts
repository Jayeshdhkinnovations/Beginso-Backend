// Shared builders for all template waves (recipe: AI_TEMPLATES_REBUILD_PROMPT.md).
//
// Notes for whoever wires this into the real seed:
//  * `_showIf` is INTENT ONLY. Map it to the real show-if shape (equals only) or the seed test will reject it.
//  * `yesLabel` / `noLabel` need branch feat/yes-no-labels. Until then the field shows Yes / No.
//  * `tags`, `featured`, `sortOrder`, `estimatedMinutes` need feat/templates-tags-and-sync.
//  * `branding.theme.labels` and `branding.theme.success` follow the version 1 theme contract.
//  * No icon is set anywhere (feat/form-icon-none). No gradients, no photos (library pictures only, later).
//  * Run brandingSchema over every template, and the contrast check over every Look, before syncing.
//  * Nothing here is written to MongoDB. The backend owner runs the sync script (dry run first).
//  * "multiple_choice" with 5 or fewer options replaces the old dropdowns. Whether it shows as tiles
//    follows the Look's form-wide choice setting.

import { LOOKS, LookId } from "./looks";

export type FieldType =
  | "short_text" | "long_text" | "email" | "phone" | "number" | "date" | "time" | "datetime"
  | "dropdown" | "multiple_choice" | "checkbox" | "yes_no" | "rating" | "file_upload"
  | "image_upload" | "signature" | "url" | "address" | "currency";

export interface F {
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  options?: string[];
  min?: number;
  max?: number;
  maxFileSize?: number;
  allowedMimeTypes?: string[];
  yesLabel?: string;
  noLabel?: string;
  _showIf?: { field: string; equals: string };
}

export interface Opt {
  required?: boolean;
  ph?: string; // placeholder: only when an example truly helps
  help?: string; // help text: only when it adds information
  min?: number;
  max?: number;
  showIf?: { field: string; equals: string };
}

export function field(type: FieldType, label: string, o: Opt = {}, extra: Partial<F> = {}): F {
  const f: F = { label, type, required: !!o.required, ...extra };
  if (o.ph) f.placeholder = o.ph;
  if (o.help) f.helpText = o.help;
  if (o.min !== undefined) f.min = o.min;
  if (o.max !== undefined) f.max = o.max;
  if (o.showIf) f._showIf = o.showIf;
  return f;
}

export const text = (l: string, o?: Opt) => field("short_text", l, o);
export const longText = (l: string, o?: Opt) => field("long_text", l, o);
export const email = (l: string, o?: Opt) => field("email", l, o);
export const phone = (l: string, o?: Opt) => field("phone", l, o);
export const num = (l: string, o?: Opt) => field("number", l, o);
export const date = (l: string, o?: Opt) => field("date", l, o);
export const time = (l: string, o?: Opt) => field("time", l, o);
export const dateTime = (l: string, o?: Opt) => field("datetime", l, o);
export const choice = (l: string, options: string[], o?: Opt) => field("multiple_choice", l, o, { options });
export const multi = (l: string, options: string[], o?: Opt) => field("checkbox", l, o, { options });
export const rating = (l: string, o?: Opt) => field("rating", l, o);
export const yesNo = (l: string, o?: Opt, yes?: string, no?: string) =>
  field("yes_no", l, o, yes && no ? { yesLabel: yes, noLabel: no } : {});
export const url = (l: string, o?: Opt) => field("url", l, o);
export const address = (l: string, o?: Opt) => field("address", l, o);
export const currency = (l: string, o?: Opt) => field("currency", l, o);
export const signature = (l: string, o?: Opt) => field("signature", l, o);
export const photo = (l: string, o?: Opt) =>
  field("image_upload", l, o, { maxFileSize: 10, allowedMimeTypes: ["image/jpeg", "image/png"] });
export const pdf = (l: string, o?: Opt) =>
  field("file_upload", l, o, { maxFileSize: 10, allowedMimeTypes: ["application/pdf"] });

export const R = { required: true };

export interface Step { title: string; description?: string; fields: F[] }

export interface TemplateIn {
  name: string;
  slug: string;
  category: string;
  tags: string[];
  description: string; // says the outcome
  look: LookId;
  layout?: string; // overrides the Look's default
  brand?: string; // replaces the Look's brand colour (keep the contrast check passing)
  banner?: string;
  steps: Step[];
  submit: string; // button words
  next?: string;
  back?: string;
  headline: string; // thank-you headline (60 characters or fewer)
  message: string; // thank-you message: what happens next
  confetti?: boolean;
  featured?: boolean;
}

let order = 0;

export function tpl(t: TemplateIn) {
  const look = LOOKS[t.look];
  const pages = t.steps.map((s, i) => ({
    id: `page-${i + 1}`,
    order: i,
    title: s.title,
    ...(s.description ? { description: s.description } : {}),
  }));
  const fields = t.steps.flatMap((s, i) => s.fields.map((f) => ({ pageId: `page-${i + 1}`, ...f })));
  const labels: Record<string, string> = { submit: t.submit };
  if (t.next) labels.next = t.next;
  if (t.back) labels.back = t.back;
  const theme = {
    ...look.theme,
    colors: { ...look.theme.colors },
    labels,
    success: { headline: t.headline, ...(t.confetti ? { confetti: true } : {}) },
  };
  const legacy: Record<string, string> = { ...look.legacy };
  if (t.brand) legacy.primaryColor = t.brand;
  if (t.banner) legacy.bannerText = t.banner;
  order += 1;
  return {
    name: t.name,
    slug: t.slug,
    category: t.category,
    tags: t.tags,
    description: t.description,
    theme: t.slug, // template theme id, as in the current seed
    isActive: true,
    featured: !!t.featured,
    sortOrder: order,
    estimatedMinutes: Math.max(1, Math.ceil(fields.length * 0.4)),
    pages,
    fields,
    settings: { layout: t.layout ?? look.layout, successMessage: t.message },
    branding: { ...legacy, theme },
  };
}

export const LEADS = "Leads & Contact";
export const ORDERS = "Orders & Payments";
export const EVENTS = "Events & RSVPs";
export const BOOKINGS = "Bookings";
export const FEEDBACK = "Feedback & Surveys";
export const HR = "HR & Hiring";
export const EDU = "Education";
export const REAL = "Real Estate";
export const COMMUNITY = "Community & Membership";
export const INTERNAL = "Internal Requests & Inspections";
export const CONSENT = "Consent & Legal";


export const HEALTH = "Healthcare";
export const FUN = "Fun & Polls";
export const SAMPLE =
  "Sample template. Have a professional check the wording and rules for your country before using it.";
export const fileUpload = (l: string, mimes: string[], o?: Opt) =>
  field("file_upload", l, o, { maxFileSize: 10, allowedMimeTypes: mimes });
