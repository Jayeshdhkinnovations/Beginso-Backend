import mongoose, { Schema, Document } from "mongoose";

// A private per-user bookmark on a form. Pinning never touches the form or what teammates see.
export interface IFormPin extends Document {
  userId: mongoose.Types.ObjectId;
  formId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId | null; // null for personal forms
  pinnedAt: Date;
}

const FormPinSchema = new Schema<IFormPin>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  formId: { type: Schema.Types.ObjectId, ref: "Form", required: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
  pinnedAt: { type: Date, default: Date.now },
});

FormPinSchema.index({ userId: 1, formId: 1 }, { unique: true });
FormPinSchema.index({ userId: 1, pinnedAt: -1 });
FormPinSchema.index({ formId: 1 });

export default mongoose.model<IFormPin>("FormPin", FormPinSchema);
