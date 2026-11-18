// The Looks (ready-made form styles): ONE data file, src/data/formLooks.json, owned by the backend. The API serves it (GET /api/form-looks) and the
// frontend keeps a copy for when the API cannot be reached, made from this same file by its `npm run sync:looks` (a test there fails when they differ).
// The built-in templates take their colours from here by id (lookBranding), so a template and its Look can never drift apart.
import { createHash } from "crypto";
import looksJson from "../data/formLooks.json";

export interface FormLook {
  id: string;
  name: string;
  /** One line about how it looks. */
  note: string;
  /** What it suits, in a few words. */
  goodFor: string;
  layout: string;
  /** Hidden from the Looks gallery. A form or template that already uses it keeps working: nothing is deleted. */
  retired?: boolean;
  branding: Record<string, any>;
}

/** The file's own version number: raise it by one whenever the Looks change, so a copy that is behind is easy to see. */
export const FORM_LOOKS_FILE_VERSION: number = looksJson.version;
export const FORM_LOOKS: readonly FormLook[] = looksJson.looks as FormLook[];

/** A short fingerprint of the file's content: the frontend's copy records it, so a copy that is out of date is easy to see. */
export const FORM_LOOKS_VERSION = createHash("sha256").update(JSON.stringify(looksJson)).digest("hex").slice(0, 12);

export const lookById = (id: string): FormLook => {
  const look = FORM_LOOKS.find((l) => l.id === id);
  if (!look) throw new Error(`Unknown Look "${id}"`);
  return look;
};

/** The branding a template takes from a Look (a copy, so a template can change a value without touching the Look), and the Look's layout. */
export const lookBranding = (id: string): { layout: string; branding: Record<string, any> } => {
  const look = lookById(id);
  return { layout: look.layout, branding: JSON.parse(JSON.stringify(look.branding)) };
};

// ── Readability: the same pairs the branding studio checks (text 4.5 to 1, field border and brand colour 3 to 1) ──────────────────────────────
const DEFAULT = { text: "#041347", card: "#FFFFFF", field: "#FFFFFF", fieldBorder: "#DDE1EA", buttonText: "#FFFFFF", page: "#F7F8FB", brand: "#1D4ED8" } as const;

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

export interface ReadabilityCheck {
  id: string;
  need: number;
  ratio: number;
}

/** Every pair of a branding that can be measured. The page behind is measured only when it is one colour (a picture or a pattern cannot be). */
export function readabilityChecks(b: Record<string, any>): ReadabilityCheck[] {
  const c = b.theme?.colors ?? {};
  const text = c.text ?? DEFAULT.text;
  const card = c.card ?? DEFAULT.card;
  const field = c.field ?? DEFAULT.field;
  const brand = b.primaryColor ?? DEFAULT.brand;
  const outline = b.buttonStyle === "outline";
  const buttonText = outline ? brand : (c.buttonText ?? DEFAULT.buttonText);
  const buttonBg = outline ? "#FFFFFF" : brand;
  const page = b.backgroundStyle === "plain" ? DEFAULT.page : b.backgroundStyle === "solid" ? (b.backgroundColor ?? brand) : undefined;
  const pairs: [string, number, string, string][] = [
    ["text-card", 4.5, text, card],
    ["text-field", 4.5, text, field],
    ["button", 4.5, buttonText, buttonBg],
    ["border", 3, c.fieldBorder ?? DEFAULT.fieldBorder, card],
    ["brand-card", 3, brand, card],
  ];
  if (page) pairs.push(["text-page", 4.5, text, page], ["brand-page", 3, brand, page]);
  if (c.heading) {
    pairs.push(["heading-card", 4.5, c.heading, card]);
    if (page) pairs.push(["heading-page", 4.5, c.heading, page]);
    // a heading colour also colours the title on the coloured header, so it is measured against the brand colour there (not when the header is a picture)
    if (b.panelTreatment !== "image") pairs.push(["heading-header", 4.5, c.heading, brand]);
  }
  return pairs.map(([id, need, a, bg]) => ({ id, need, ratio: Math.round(contrastRatio(a, bg) * 100) / 100 }));
}
