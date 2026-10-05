import mongoose, { Schema, Document } from "mongoose";
import { IFormField, FormFieldSchema, IFormSettings, FormSettingsSchema } from "./Form";
import { getTemplateDescription, getTemplateSettings } from "../utils/templateDefaults";

export interface ITemplate extends Document {
  name: string;
  description: string;
  settings: IFormSettings;
  category: string;
  fields: IFormField[];
  pages?: any[];
  theme: string;
  isActive: boolean;
  // Sprint 13 (B6.1): null/absent = a built-in Beginso template; set = that workspace's own template.
  workspaceId?: mongoose.Types.ObjectId | null;
  createdBy?: mongoose.Types.ObjectId | null;
  sourceFormId?: mongoose.Types.ObjectId | null;
  // Workspace templates carry the source form's theme (branding) so a form made from one looks the same.
  branding?: Record<string, any>;
}

const TemplateSchema = new Schema<ITemplate>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
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
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    sourceFormId: { type: Schema.Types.ObjectId, ref: "Form", default: null },
    branding: { type: Schema.Types.Mixed, default: undefined },
  },
  {
    timestamps: true,
  }
);

const Template = mongoose.model<ITemplate>("Template", TemplateSchema);
export default Template;
