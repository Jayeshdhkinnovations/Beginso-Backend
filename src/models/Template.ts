import mongoose, { Schema, Document } from "mongoose";
import { IFormField, FormFieldSchema, IFormSettings, FormSettingsSchema } from "./Form";
import { getTemplateDescription, getTemplateSettings, slugify } from "../utils/templateDefaults";

export interface ITemplate extends Document {
  name: string;
  // The public gallery's URL segment (/discover-templates/:slug) — a readable name instead of the
  // raw ObjectId. Unique, sparse so older rows inserted before this field existed (if any slip
  // through a migration) don't collide on a shared `null`.
  slug: string;
  description: string;
  settings: IFormSettings;
  category: string;
  fields: IFormField[];
  pages?: any[];
  theme: string;
  isActive: boolean;
  // false = internal/demo template: hidden from the PUBLIC gallery (and so from the guest builder), still listed for signed-in users.
  showInGallery?: boolean;
  // Sprint 13 (B6.1): null/absent = a built-in Beginso template; set = that workspace's own template.
  workspaceId?: mongoose.Types.ObjectId | null;
  createdBy?: mongoose.Types.ObjectId | null;
  sourceFormId?: mongoose.Types.ObjectId | null;
  // Workspace templates carry the source form's theme (branding) so a form made from one looks the same.
  branding?: Record<string, any>;
  // Gallery metadata (built-in templates): other groups and topics it belongs to, the featured strip, the order, and about how many minutes it takes to fill.
  tags?: string[];
  featured?: boolean;
  sortOrder?: number;
  estimatedMinutes?: number;
  /** The release a built-in template belongs to (1, 2 or 3); none for the older catalogue. A wave is synced on its own. */
  wave?: number;
  /** Old slugs this template replaces: when its wave is synced those templates are switched off, and an old link opens this one. */
  replaces?: string[];
  // A picture of the template for a card, when one has been made ahead of time (null: the card draws it from the template itself).
  thumbnail?: string | null;
}

const TemplateSchema = new Schema<ITemplate>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
      default: function (this: ITemplate) { return slugify(this.name); },
    },
    description: {
      type: String,
      trim: true,
      default: function (this: ITemplate) { return getTemplateDescription(this.name); },
    },
    settings: {
      type: FormSettingsSchema,
      default: getTemplateSettings,
    },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    fields: {
      type: [FormFieldSchema],
      required: true,
      default: [],
    },
    pages: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    theme: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
    showInGallery: { type: Boolean, default: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    sourceFormId: { type: Schema.Types.ObjectId, ref: "Form", default: null },
    branding: { type: Schema.Types.Mixed, default: undefined },
    tags: { type: [String], default: [] },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 1000 },
    estimatedMinutes: { type: Number, default: undefined, min: 1, max: 120 },
    wave: { type: Number, min: 1, max: 3 },
    replaces: { type: [String], default: [] },
    thumbnail: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// The public gallery lists active, built-in templates, featured first and then in the catalogue's order.
TemplateSchema.index({ isActive: 1, workspaceId: 1, featured: -1, sortOrder: 1 });
TemplateSchema.index({ tags: 1 });

const Template = mongoose.model<ITemplate>("Template", TemplateSchema);
export default Template;
