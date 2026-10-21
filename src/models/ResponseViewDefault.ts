import mongoose, { Schema, Document } from "mongoose";

export const RESPONSE_LAYOUTS = ["grid", "list", "table"] as const;
export const RESPONSE_DENSITIES = ["comfortable", "compact"] as const;
export const MAX_PINNED_ANSWERS = 4;
export type ResponseLayout = (typeof RESPONSE_LAYOUTS)[number];
export type ResponseDensity = (typeof RESPONSE_DENSITIES)[number];

export interface IResponseViewField {
  fieldId: string;
  hidden?: boolean;
  span?: "half" | "full";
  order?: number;
}

// How a form's submitted response is arranged for everyone who has not picked their own layout (one row per form).
// Cosmetic only: hiding a field here never removes it from exports, the API or the PDF.
// `pinned` and `fields` are stored from phase 2 ("Customize this view"); phase 1 only writes the four display settings.
export interface IResponseViewDefault extends Document {
  workspaceId: mongoose.Types.ObjectId | null; // null for personal forms
  formId: mongoose.Types.ObjectId;
  layout: ResponseLayout;
  density: ResponseDensity;
  showEmpty: boolean;
  showNumbers: boolean;
  pinned: string[];
  fields: IResponseViewField[];
  version: number; // compare-and-swap counter for the stale-save guard (409)
  updatedBy: mongoose.Types.ObjectId;
  updatedAt: Date;
}

const ViewFieldSchema = new Schema<IResponseViewField>(
  {
    fieldId: { type: String, required: true },
    hidden: { type: Boolean },
    span: { type: String, enum: ["half", "full"] },
    order: { type: Number },
  },
  { _id: false }
);

const ResponseViewDefaultSchema = new Schema<IResponseViewDefault>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
  formId: { type: Schema.Types.ObjectId, ref: "Form", required: true },
  layout: { type: String, enum: RESPONSE_LAYOUTS, required: true },
  density: { type: String, enum: RESPONSE_DENSITIES, required: true },
  showEmpty: { type: Boolean, required: true },
  showNumbers: { type: Boolean, required: true },
  pinned: { type: [String], default: [], validate: (v: string[]) => v.length <= MAX_PINNED_ANSWERS },
  fields: { type: [ViewFieldSchema], default: [] },
  version: { type: Number, default: 1 },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  updatedAt: { type: Date, default: Date.now },
});

ResponseViewDefaultSchema.index({ formId: 1 }, { unique: true });
ResponseViewDefaultSchema.index({ workspaceId: 1 });

export default mongoose.model<IResponseViewDefault>("ResponseViewDefault", ResponseViewDefaultSchema);
