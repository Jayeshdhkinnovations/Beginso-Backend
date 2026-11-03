import mongoose, { Document, Schema } from "mongoose";

// A saved form style ("Save my style"): the LOOK of a form (its layout and its branding without any uploaded picture, logo or text) kept so it can be
// applied to other forms. A workspace's styles are shared by its members; in the personal space a style belongs to the person who saved it.
export interface IFormStyle extends Document {
  workspaceId: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  name: string;
  layout: string;
  // Already checked by validations/formStyle.validator.ts before it is stored.
  branding: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const FormStyleSchema = new Schema<IFormStyle>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    layout: { type: String, required: true },
    branding: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export const MAX_STYLES_PER_SCOPE = 20;

export default mongoose.model<IFormStyle>("FormStyle", FormStyleSchema);
