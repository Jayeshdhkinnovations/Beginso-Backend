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

export interface IBranding {
  primaryColor?: string;
  logoUrl?: string;
  coverImageUrl?: string;
}

export interface IFormSettings {
  successMessage?: string;
  responseLimitEnabled?: boolean;
  responseLimit?: number;
  closeDate?: string;
  honeypotEnabled?: boolean;
  layout?: "single_column" | "two_column" | "compact";
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
  viewsCount?: number;
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
      enum: ["single_column", "two_column", "compact"],
      default: "single_column",
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
    viewsCount: { type: Number, default: 0 },
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

const Form = mongoose.model<IForm>("Form", FormSchema);
export default Form;

