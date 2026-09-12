import mongoose, { Schema, Document } from "mongoose";
import { WorkspaceRole } from "../types/workspace.types";

export interface IFormAccessGrant extends Document {
  formId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: WorkspaceRole;
  grantedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FormAccessGrantSchema = new Schema<IFormAccessGrant>(
  {
    formId: {
      type: Schema.Types.ObjectId,
      ref: "Form",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: {
      type: String,
      enum: ["owner", "admin", "member", "editor", "viewer", "reviewer"],
      default: "reviewer",
      required: true,
    },
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: a user has at most one grant per form
FormAccessGrantSchema.index({ formId: 1, userId: 1 }, { unique: true });
FormAccessGrantSchema.index({ userId: 1 });

const FormAccessGrant = mongoose.model<IFormAccessGrant>(
  "FormAccessGrant",
  FormAccessGrantSchema
);

export default FormAccessGrant;
