import mongoose, { Schema, Document } from "mongoose";
import { attachStorageHooks } from "../services/storage.service";

export interface ICondition {
  fieldId: string;
  operator: "equals";
  value: string;
}

export interface ILogicRule {
  ruleId?: string;
  targetFieldId: string;
  action: "show" | "hide";
  
  // Support both shapes
  condition?: ICondition;
  operator?: "equals";
  value?: string;
}

export interface IFormPage {
  id: string;
  order: number;
  title?: string;
  description?: string;
}

// Field types added after V1. Kept as a list so the schema enum, the zod validator and the type stay in step.
export const EXTRA_FIELD_TYPES = ["rating", "yes_no", "url", "time", "datetime", "currency", "address", "signature", "image_upload"] as const;
export type FieldTypeExtra = (typeof EXTRA_FIELD_TYPES)[number];

export const CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;
export const PREVIEW_POSITIONS = ["top", "inline"] as const;
export const ASPECT_RATIOS = ["original", "16:9", "1:1"] as const;
export const PREVIEW_SIZES = ["small", "medium", "large"] as const;
export const URL_PREVIEW_STYLES = ["rich", "compact", "text"] as const;
export const URL_DISPLAYS = ["card", "inline"] as const;
export const MAX_IMAGES_PER_FIELD = 10;
export type Currency = (typeof CURRENCIES)[number];
export type PreviewPosition = (typeof PREVIEW_POSITIONS)[number];
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type PreviewSize = (typeof PREVIEW_SIZES)[number];
export type UrlPreviewStyle = (typeof URL_PREVIEW_STYLES)[number];
export type UrlDisplay = (typeof URL_DISPLAYS)[number];

export interface IFormField {
  fieldId?: string;
  pageId?: string;
  label: string;
  type:
    | "short_text"
    | "long_text"
    | "email"
    | "phone"
    | "number"
    | "date"
    | "dropdown"
    | "multiple_choice"
    | "checkbox"
    | "file_upload"
    | FieldTypeExtra;
  required: boolean;
  deleted?: boolean;
  placeholder?: string;
  helpText?: string;

  // validation settings for different field types
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
  options?: string[];
  maxFileSize?: number;
  allowedMimeTypes?: string[];
  // Display & preview settings (stored with the field so every response renders the same way).
  currency?: Currency;
  allowMultiple?: boolean;
  maxImages?: number;
  previewPosition?: PreviewPosition;
  aspectRatio?: AspectRatio;
  previewSize?: PreviewSize;
  urlPreviewStyle?: UrlPreviewStyle;
  urlDisplay?: UrlDisplay;
  urlPreviewPosition?: PreviewPosition;
  urlAspectRatio?: AspectRatio;
  urlPreviewSize?: PreviewSize;
  logicRules?: ILogicRule[];
}

// Sprint 13 (CF2.3, wireframe "Branding controls"): a curated set of theme choices - a handful of good options
// rather than a free-form editor, so every form looks professional. All optional; absent = the default.
export const BUTTON_STYLES = ["solid", "outline"] as const;
export const BUTTON_RADII = ["4px", "8px", "16px"] as const;
export const COVER_POSITIONS = ["center", "top", "bottom"] as const;
export const FORM_SPACINGS = ["compact", "comfortable", "spacious"] as const;
// Respondent-form look: a curated font list (loaded by the frontend), a type scale, the card surface, the colour
// panel treatment and whether short fields pair up into two columns.
// The typefaces a form can use (the frontend loads each from Google Fonts, only when a form uses it). The first five are the original set.
export const FORM_FONTS = [
  "dm_sans", "inter", "work_sans", "lora", "nunito",
  "poppins", "manrope", "plus_jakarta_sans", "outfit", "space_grotesk", "montserrat",
  "playfair_display", "merriweather", "source_serif_4", "fraunces", "dm_serif_display",
  "quicksand", "fredoka",
  "caveat", "pacifico", "bebas_neue", "space_mono",
] as const;
export const TYPE_SCALES = ["compact", "default", "large"] as const;
export const CARD_STYLES = ["flat", "soft", "bordered", "elevated"] as const;
export const PANEL_TREATMENTS = ["solid", "gradient", "image", "pattern"] as const;
export const FIELD_GROUPINGS = ["auto", "single"] as const;
// The page behind the form card (not the card itself): how it is filled, and the colour it is built from.
// How the cover image is shown: cropped to the banner strip, or whole at its own size and ratio.
export const COVER_FITS = ["banner", "original"] as const;
// How big the form's logo is drawn on the header: small, medium (the default) or large.
export const LOGO_SIZES = ["sm", "md", "lg"] as const;
export const FORM_WIDTHS = ["narrow", "standard", "wide"] as const;
// The owner's own colours, fields look and exact sizes: one versioned object (branding.theme). Every key is optional; absent = the default look.
export const THEME_VERSION = 1;
// Split Feature: which side the picture panel is on, in reading order (start = the left in left-to-right languages).
export const PANEL_SIDES = ["start", "end"] as const;
export const FIELD_STYLES = ["outlined", "filled", "underline"] as const;
export const LABEL_POSITIONS = ["above", "start"] as const;
export const CHOICE_STYLES = ["plain", "tiles"] as const;
// Buttons and details of the respondent form: how big and wide the buttons are, how they react to the pointer, and how the multi-page progress is drawn.
export const BUTTON_SIZES = ["small", "default", "large"] as const;
export const BUTTON_WIDTHS = ["fill", "auto"] as const;
export const BUTTON_HOVERS = ["none", "lift", "darken"] as const;
export const PROGRESS_STYLES = ["bar", "dots", "steps"] as const;
export const PAGE_BACKGROUNDS = ["wash", "plain", "solid", "gradient", "mesh", "dots", "grid", "image"] as const;

export interface IFormTheme {
  v: number;
  colors?: { text?: string; heading?: string; card?: string; field?: string; fieldBorder?: string; buttonText?: string };
  fields?: { style?: (typeof FIELD_STYLES)[number]; radius?: number; label?: (typeof LABEL_POSITIONS)[number]; choice?: (typeof CHOICE_STYLES)[number] };
  card?: { radius?: number; shadow?: number };
  layout?: { maxWidth?: number; fieldGap?: number; panelSide?: (typeof PANEL_SIDES)[number] };
  // Typeface of the headings (the form title and page titles); absent = the same as the form's font.
  fonts?: { heading?: (typeof FORM_FONTS)[number] };
  // The photographer of an Unsplash photo used as the cover and/or the page background, one credit for each picture: shown on the form (Unsplash's rule). Only an unsplash.com profile address.
  credit?: { cover?: { name: string; url: string }; background?: { name: string; url: string } };
  buttons?: { size?: (typeof BUTTON_SIZES)[number]; width?: (typeof BUTTON_WIDTHS)[number]; hover?: (typeof BUTTON_HOVERS)[number] };
  // The owner's own words on the buttons (absent = Submit, Next, Back), a short line under the form, and the style of the multi-page progress.
  labels?: { submit?: string; next?: string; back?: string };
  progress?: { style?: (typeof PROGRESS_STYLES)[number] };
  footer?: { note?: string };
  // The screen a respondent sees after sending: a headline of the owner's own, an accent colour, a picture, confetti, and an optional move on to another page (https only).
  success?: { headline?: string; colour?: string; picture?: string; confetti?: boolean; redirect?: { url: string; seconds?: number } };
}

export interface IBranding {
  theme?: IFormTheme | null; // null only travels in a PATCH (clears it); it is never stored
  primaryColor?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  buttonStyle?: (typeof BUTTON_STYLES)[number];
  buttonRadius?: (typeof BUTTON_RADII)[number];
  coverPosition?: (typeof COVER_POSITIONS)[number];
  showProgress?: boolean;
  spacing?: (typeof FORM_SPACINGS)[number];
  fontFamily?: (typeof FORM_FONTS)[number];
  typeScale?: (typeof TYPE_SCALES)[number];
  cardStyle?: (typeof CARD_STYLES)[number];
  panelTreatment?: (typeof PANEL_TREATMENTS)[number];
  fieldGrouping?: (typeof FIELD_GROUPINGS)[number];
  backgroundStyle?: (typeof PAGE_BACKGROUNDS)[number];
  backgroundColor?: string;
  backgroundImageUrl?: string;
  formWidth?: (typeof FORM_WIDTHS)[number];
  coverFit?: (typeof COVER_FITS)[number];
  logoSize?: (typeof LOGO_SIZES)[number];
  // The form's own icon when it has no uploaded logo: a name from the frontend's icon set (a slug, never rendered as markup) and a colour.
  iconName?: string;
  iconColor?: string;
  // A line of text and one link shown on the form's header, under the title.
  bannerText?: string;
  bannerLinks?: { label?: string; url: string }[];
}

// Sprint 13 (CF2.7): six layout presets. The three V1 values stay valid on read and write and are
// normalised by utils/layout.ts - no data migration.
export type FormLayout =
  | "classic"
  | "card_stack"
  | "guided"
  | "steps"
  | "split_feature"
  | "compact"
  | "chat"
  | "sidebar"
  | "open"
  | "focus"
  | "single_column"
  | "two_column";

export const FORM_LAYOUT_VALUES: FormLayout[] = [
  "classic",
  "card_stack",
  "guided",
  "steps",
  "split_feature",
  "compact",
  "chat",
  "sidebar",
  "open",
  "focus",
  "single_column",
  "two_column",
];

// Sprint 13 (D1.1): who may respond. A form with no stored value is "open" (Mode 1) - that is what
// every pre-Sprint-13 form is, which is why there is deliberately NO schema default: a Mongoose default
// is applied when a document is read, and would silently turn every existing form into Mode 2.
export type AccessMode = "open" | "tracked" | "login";
export const ACCESS_MODE_VALUES: AccessMode[] = ["open", "tracked", "login"];

export interface IFormSettings {
  successMessage?: string;
  responseLimitEnabled?: boolean;
  responseLimit?: number;
  closeDate?: string;
  honeypotEnabled?: boolean;
  layout?: FormLayout;
  accessMode?: AccessMode;
}

export interface IForm extends Document {
  title: string;
  /** Three letters taken from the title when the first response arrives; the middle part of every response reference. Unique in its workspace. */
  refCode?: string;
  description?: string;
  workspaceId?: mongoose.Types.ObjectId | null;
  createdBy?: mongoose.Types.ObjectId | null;
  status: "draft" | "published" | "closed";
  fields: IFormField[];
  pages: IFormPage[];
  schemaVersion: number;
  slug?: string;
  publishedSlug?: string;
  publishedAt?: Date;
  // Sprint 13 (CF5.6): Archive - indefinite, intentional, never expires. Distinct from Trash.
  archivedAt?: Date | null;
  archivedBy?: mongoose.Types.ObjectId | null;
  // Sprint 13 (CF5.5): Trash - reversible soft delete, purged after 30 days by the retention sweep.
  // Every Form find/count excludes these unless the query sets `includeDeleted` (see the hook below).
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId | null;
  viewsCount?: number;
  // Bumped only by a save that changes builder content; the stale-save check compares it (see utils/staleForm.ts).
  contentVersion?: number;
  // The saveId of the last content save, so a retry of a save whose reply was lost is recognised and not refused.
  lastSaveId?: string | null;
  // Sprint 14 (B1.2): set only when the form was created from a template (POST /api/templates/:id/use). Null
  // for every other form, and for forms made before Sprint 14 - there is no backfill (OQ-4).
  templateId?: mongoose.Types.ObjectId | null;
  templateCategory?: string | null;
  branding?: IBranding;
  settings?: IFormSettings;
  createdAt: Date;
  updatedAt: Date;
}

const ConditionSchema = new Schema<ICondition>(
  {
    fieldId: { type: String, required: true },
    operator: { type: String, enum: ["equals"], default: "equals" },
    value: { type: String, required: true },
  },
  { _id: false }
);

const LogicRuleSchema = new Schema<ILogicRule>(
  {
    ruleId: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    targetFieldId: { type: String, required: true },
    condition: { type: ConditionSchema, required: false },
    operator: { type: String, enum: ["equals"], default: "equals" },
    value: { type: String, required: false },
    action: { type: String, enum: ["show", "hide"], required: true },
  },
  { _id: false }
);

export const FormFieldSchema = new Schema<IFormField>({
  fieldId: { type: String, required: true, default: () => new mongoose.Types.ObjectId().toString() },
  pageId: { type: String, required: false },
  label: { type: String, required: true, trim: true },
  type: {
    type: String,
    required: true,
    enum: [
      "short_text",
      "long_text",
      "email",
      "phone",
      "number",
      "date",
      "dropdown",
      "multiple_choice",
      "checkbox",
      "file_upload",
      ...EXTRA_FIELD_TYPES,
    ],
  },
  required: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  helpText: { type: String, default: "" },

  // Validation parameters
  minLength: { type: Number },
  maxLength: { type: Number },
  pattern: { type: String },
  min: { type: Number },
  max: { type: Number },
  minDate: { type: String },
  maxDate: { type: String },
  options: { type: [String], default: [] },
  maxFileSize: { type: Number },
  allowedMimeTypes: { type: [String], default: [] },
  currency: { type: String, enum: CURRENCIES },
  allowMultiple: { type: Boolean },
  maxImages: { type: Number },
  previewPosition: { type: String, enum: PREVIEW_POSITIONS },
  aspectRatio: { type: String, enum: ASPECT_RATIOS },
  previewSize: { type: String, enum: PREVIEW_SIZES },
  urlPreviewStyle: { type: String, enum: URL_PREVIEW_STYLES },
  urlDisplay: { type: String, enum: URL_DISPLAYS },
  urlPreviewPosition: { type: String, enum: PREVIEW_POSITIONS },
  urlAspectRatio: { type: String, enum: ASPECT_RATIOS },
  urlPreviewSize: { type: String, enum: PREVIEW_SIZES },
  logicRules: { type: [LogicRuleSchema], default: [] },
});

const FormPageSchema = new Schema<IFormPage>(
  {
    id: { type: String, required: true },
    order: { type: Number, required: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const ThemeSchema = new Schema<IFormTheme>(
  {
    v: { type: Number, required: true },
    colors: new Schema({ text: String, heading: String, card: String, field: String, fieldBorder: String, buttonText: String }, { _id: false }),
    fields: new Schema({ style: { type: String, enum: FIELD_STYLES }, radius: Number, label: { type: String, enum: LABEL_POSITIONS }, choice: { type: String, enum: CHOICE_STYLES } }, { _id: false }),
    card: new Schema({ radius: Number, shadow: Number }, { _id: false }),
    layout: new Schema({ maxWidth: Number, fieldGap: Number, panelSide: { type: String, enum: PANEL_SIDES } }, { _id: false }),
    fonts: new Schema({ heading: { type: String, enum: FORM_FONTS } }, { _id: false }),
    buttons: new Schema({ size: { type: String, enum: BUTTON_SIZES }, width: { type: String, enum: BUTTON_WIDTHS }, hover: { type: String, enum: BUTTON_HOVERS } }, { _id: false }),
    labels: new Schema({ submit: String, next: String, back: String }, { _id: false }),
    progress: new Schema({ style: { type: String, enum: PROGRESS_STYLES } }, { _id: false }),
    footer: new Schema({ note: String }, { _id: false }),
    success: new Schema({ headline: String, colour: String, picture: String, confetti: Boolean, redirect: new Schema({ url: String, seconds: Number }, { _id: false }) }, { _id: false }),
    credit: new Schema({ cover: new Schema({ name: String, url: String }, { _id: false }), background: new Schema({ name: String, url: String }, { _id: false }) }, { _id: false }),
  },
  { _id: false }
);

const BrandingSchema = new Schema<IBranding>(
  {
    theme: { type: ThemeSchema },
    primaryColor: { type: String },
    logoUrl: { type: String },
    coverImageUrl: { type: String },
    buttonStyle: { type: String, enum: BUTTON_STYLES },
    buttonRadius: { type: String, enum: BUTTON_RADII },
    coverPosition: { type: String, enum: COVER_POSITIONS },
    showProgress: { type: Boolean },
    spacing: { type: String, enum: FORM_SPACINGS },
    fontFamily: { type: String, enum: FORM_FONTS },
    typeScale: { type: String, enum: TYPE_SCALES },
    cardStyle: { type: String, enum: CARD_STYLES },
    panelTreatment: { type: String, enum: PANEL_TREATMENTS },
    fieldGrouping: { type: String, enum: FIELD_GROUPINGS },
    backgroundStyle: { type: String, enum: PAGE_BACKGROUNDS },
    backgroundColor: { type: String },
    backgroundImageUrl: { type: String },
    formWidth: { type: String, enum: FORM_WIDTHS },
    coverFit: { type: String, enum: COVER_FITS },
    logoSize: { type: String, enum: LOGO_SIZES },
    iconName: { type: String },
    iconColor: { type: String },
    bannerText: { type: String },
    bannerLinks: { type: [new Schema({ label: { type: String }, url: { type: String, required: true } }, { _id: false })], default: undefined },
  },
  { _id: false }
);

export const FormSettingsSchema = new Schema<IFormSettings>(
  {
    successMessage: { type: String },
    responseLimitEnabled: { type: Boolean, default: false },
    responseLimit: { type: Number },
    closeDate: { type: String },
    honeypotEnabled: { type: Boolean, default: false },
    layout: {
      type: String,
      enum: FORM_LAYOUT_VALUES,
      default: "single_column",
    },
    accessMode: {
      type: String,
      enum: ACCESS_MODE_VALUES,
    },
  },
  { _id: false }
);

const FormSchema = new Schema<IForm>(
  {
    title: { type: String, required: true, trim: true },
    refCode: { type: String, trim: true },
    description: { type: String, default: "" },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: false,
      default: null,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "published", "closed"],
      default: "draft",
      index: true,
    },
    fields: { type: [FormFieldSchema], default: [] },
    pages: { type: [FormPageSchema], default: [] },
    schemaVersion: {
      type: Number,
      default: 1,
      required: true,
    },
    slug: { type: String, unique: true, sparse: true, index: true },
    publishedSlug: { type: String, unique: true, sparse: true, index: true },
    publishedAt: { type: Date },
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    viewsCount: { type: Number, default: 0 },
    contentVersion: { type: Number, default: 0 },
    lastSaveId: { type: String, default: null },
    templateId: { type: Schema.Types.ObjectId, ref: "Template", default: null },
    templateCategory: { type: String, default: null },
    branding: { type: BrandingSchema, default: {} },
    settings: { type: FormSettingsSchema, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        if (ret.status === "published" && ret.publishedSlug) {
          ret.slug = ret.publishedSlug;
        }
        return ret;
      },
    },
    toObject: {
      transform: (doc, ret) => {
        if (ret.status === "published" && ret.publishedSlug) {
          ret.slug = ret.publishedSlug;
        }
        return ret;
      },
    },
  }
);

// Form lists sort by newest first within one workspace, or within one creator's personal space.
FormSchema.index({ workspaceId: 1, createdAt: -1 });
FormSchema.index({ createdBy: 1, workspaceId: 1, createdAt: -1 });
// A response reference names its form by this code, so two forms of one workspace never share one (trashed forms keep theirs).
FormSchema.index({ workspaceId: 1, refCode: 1 }, { unique: true, partialFilterExpression: { refCode: { $type: "string" } } });

// Trash (CF5.5). A form in Trash must be invisible to every normal read path - lists, lookups by id,
// the public slug, counts, permission resolution - so the exclusion lives in ONE place instead of
// being remembered at every call site. Maintenance code that has to see trashed forms (Trash itself,
// the retention sweep, workspace/account deletion) opts in with `.setOptions({ includeDeleted: true })`.
// A query that names `deletedAt` itself is left alone.
FormSchema.pre(["find", "findOne", "countDocuments", "findOneAndUpdate"], function (this: any) {
  if (this.getOptions?.().includeDeleted) return;
  const filter = this.getFilter?.() ?? {};
  if (Object.prototype.hasOwnProperty.call(filter, "deletedAt")) return;
  this.where({ deletedAt: null });
});

attachStorageHooks(FormSchema, "form");

const Form = mongoose.model<IForm>("Form", FormSchema);
export default Form;

