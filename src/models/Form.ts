import mongoose, { Schema, Document } from "mongoose";

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
    | "file_upload";
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
  logicRules?: ILogicRule[];
}

// Sprint 13 (CF2.3, wireframe "Branding controls"): a curated set of theme choices - a handful of good options
// rather than a free-form editor, so every form looks professional. All optional; absent = the default.
export const BUTTON_STYLES = ["solid", "outline"] as const;
export const BUTTON_RADII = ["4px", "8px", "16px"] as const;
export const COVER_POSITIONS = ["center", "top", "bottom"] as const;
export const FORM_SPACINGS = ["compact", "comfortable", "spacious"] as const;

export interface IBranding {
  primaryColor?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  buttonStyle?: (typeof BUTTON_STYLES)[number];
  buttonRadius?: (typeof BUTTON_RADII)[number];
  coverPosition?: (typeof COVER_POSITIONS)[number];
  showProgress?: boolean;
  spacing?: (typeof FORM_SPACINGS)[number];
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
  | "single_column"
  | "two_column";

export const FORM_LAYOUT_VALUES: FormLayout[] = [
  "classic",
  "card_stack",
  "guided",
  "steps",
  "split_feature",
  "compact",
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

const BrandingSchema = new Schema<IBranding>(
  {
    primaryColor: { type: String },
    logoUrl: { type: String },
    coverImageUrl: { type: String },
    buttonStyle: { type: String, enum: BUTTON_STYLES },
    buttonRadius: { type: String, enum: BUTTON_RADII },
    coverPosition: { type: String, enum: COVER_POSITIONS },
    showProgress: { type: Boolean },
    spacing: { type: String, enum: FORM_SPACINGS },
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

const Form = mongoose.model<IForm>("Form", FormSchema);
export default Form;

